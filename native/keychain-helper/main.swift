import Foundation
import Security

private let maxPayloadBytes = 64 * 1024
private let operationTimeout: TimeInterval = 5

private func fail(_ message: String, _ status: OSStatus? = nil) -> Never {
    if let status {
        FileHandle.standardError.write(Data("qlb-keychain-helper: \(message) (status \(status))\n".utf8))
    } else {
        FileHandle.standardError.write(Data("qlb-keychain-helper: \(message)\n".utf8))
    }
    exit(1)
}

private func readPayload() -> Data {
    let value = FileHandle.standardInput.readDataToEndOfFile()
    guard value.count <= maxPayloadBytes else { fail("payload exceeds 64 KiB") }
    return value
}

private func query(_ service: String, _ account: String) -> [CFString: Any] {
    [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
    ]
}

private func trustedAccess(_ service: String) -> SecAccess {
    var securityApplication: SecTrustedApplication?
    var helperApplication: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath("/usr/bin/security", &securityApplication) == errSecSuccess,
          SecTrustedApplicationCreateFromPath(CommandLine.arguments[0], &helperApplication) == errSecSuccess,
          let securityApplication,
          let helperApplication else {
        fail("could not create trusted applications")
    }
    var access: SecAccess?
    let trusted = [securityApplication, helperApplication] as CFArray
    guard SecAccessCreate(service as CFString, trusted, &access) == errSecSuccess, let access else {
        fail("could not create item access")
    }
    return access
}

private func set(_ service: String, _ account: String, _ data: Data) {
    let itemQuery = query(service, account)
    let status = SecItemCopyMatching(itemQuery as CFDictionary, nil)
    if status == errSecSuccess {
        let updateStatus = SecItemUpdate(itemQuery as CFDictionary, [kSecValueData: data] as CFDictionary)
        guard updateStatus == errSecSuccess else { fail("update failed", updateStatus) }
        return
    }
    guard status == errSecItemNotFound else { fail("lookup failed", status) }

    var attributes = itemQuery
    attributes[kSecValueData] = data
    attributes[kSecAttrAccess] = trustedAccess(service)
    let addStatus = SecItemAdd(attributes as CFDictionary, nil)
    guard addStatus == errSecSuccess else { fail("add failed", addStatus) }
}

private func delete(_ service: String, _ account: String) {
    let status = SecItemDelete(query(service, account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail("delete failed", status) }
}

private func selftest(_ service: String) {
    guard service.hasPrefix("qlb-test-") else { fail("selftest requires a qlb-test-* service") }
    let account = "qlb"
    let payload = Data(UUID().uuidString.utf8)
    defer { delete(service, account) }
    set(service, account, payload)
    var lookup = query(service, account)
    lookup[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    guard status == errSecSuccess, let roundTrip = result as? Data, roundTrip == payload else {
        fail("selftest readback failed", status)
    }
}

private struct CommandResult {
    let status: Int32
    let output: String
    let timedOut: Bool
}

private func run(_ executable: String, _ arguments: [String], input: Data? = nil) -> CommandResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    if let input {
        let stdin = Pipe()
        process.standardInput = stdin
        do { try process.run(); stdin.fileHandleForWriting.write(input); stdin.fileHandleForWriting.closeFile() }
        catch { return CommandResult(status: 1, output: "could not launch", timedOut: false) }
    } else {
        do { try process.run() } catch { return CommandResult(status: 1, output: "could not launch", timedOut: false) }
    }
    let completed = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { process.waitUntilExit(); completed.signal() }
    let timedOut = completed.wait(timeout: .now() + operationTimeout) == .timedOut
    if timedOut {
        process.terminate()
        process.waitUntilExit()
    }
    let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return CommandResult(status: timedOut ? 1 : process.terminationStatus, output: text, timedOut: timedOut)
}

private func promptFailure(_ result: CommandResult) -> Bool {
    result.timedOut || result.output.contains("-25293") || result.output.contains("-25308")
}

private func matrix(_ prefix: String, previousHelper: String? = nil) {
    guard prefix.hasPrefix("qlb-test-") else { fail("matrix requires a qlb-test-* prefix") }
    let account = "qlb"
    let marker = Data("matrix-\(UUID().uuidString)".utf8)
    let suffix = UUID().uuidString.lowercased()
    let services = ["\(prefix)security-\(suffix)", "\(prefix)previous-\(suffix)", "\(prefix)helper-\(suffix)"]
    var cases: [String: String] = ["securityCreated": "fail", "previousHelper": "skipped", "helperCreated": "fail"]
    var prompted = false
    defer { for service in services { _ = run("/usr/bin/security", ["delete-generic-password", "-a", account, "-s", service]) } }

    let securityCreated = run("/usr/bin/security", ["add-generic-password", "-a", account, "-s", services[0], "-w", String(data: marker, encoding: .utf8)!])
    let securityUpdate = securityCreated.status == 0 ? run(CommandLine.arguments[0], ["set", services[0], account], input: marker) : securityCreated
    prompted = promptFailure(securityCreated) || promptFailure(securityUpdate)
    if securityCreated.status == 0 && securityUpdate.status == 0 { cases["securityCreated"] = "pass" }

    let previous = previousHelper ?? (NSHomeDirectory() as NSString).appendingPathComponent(".qlb/helper-prev/qlb-keychain-helper")
    if FileManager.default.isExecutableFile(atPath: previous) {
        let previousCreate = run(previous, ["set", services[1], account], input: marker)
        let currentUpdate = previousCreate.status == 0 ? run(CommandLine.arguments[0], ["set", services[1], account], input: marker) : previousCreate
        prompted = prompted || promptFailure(previousCreate) || promptFailure(currentUpdate)
        cases["previousHelper"] = previousCreate.status == 0 && currentUpdate.status == 0 ? "pass" : "fail"
    }

    let helperCreate = run(CommandLine.arguments[0], ["set", services[2], account], input: marker)
    let securityRead = helperCreate.status == 0 ? run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", services[2], "-w"]) : helperCreate
    prompted = prompted || promptFailure(helperCreate) || promptFailure(securityRead)
    if helperCreate.status == 0 && securityRead.status == 0 && Data(securityRead.output.trimmingCharacters(in: .newlines).utf8) == marker {
        cases["helperCreated"] = "pass"
    }

    let result: [String: Any] = ["cases": cases, "prompted": prompted]
    let json = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
    if prompted || cases.values.contains("fail") { exit(1) }
}

let args = Array(CommandLine.arguments.dropFirst())
switch (args.count, args.first) {
case (3, "set"):
    var payload = readPayload()
    defer { payload.resetBytes(in: 0..<payload.count) }
    set(args[1], args[2], payload)
case (3, "delete"):
    delete(args[1], args[2])
case (2, "selftest"):
    selftest(args[1])
case (2, "matrix"):
    matrix(args[1])
case (3, "matrix"):
    matrix(args[1], previousHelper: args[2])
default:
    FileHandle.standardError.write(Data("usage: qlb-keychain-helper set|delete <service> <account> | selftest <qlb-test-service> | matrix <qlb-test-prefix> [previous-helper]\n".utf8))
    exit(2)
}
