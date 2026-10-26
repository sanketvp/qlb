import CryptoKit
import Foundation
import Security

private let maxPayloadBytes = 64 * 1024
private let operationTimeout: TimeInterval = 5

private func statusName(_ status: OSStatus) -> String {
    switch status {
    case errSecAuthFailed: return "errSecAuthFailed"
    case errSecInteractionNotAllowed: return "errSecInteractionNotAllowed"
    case errSecUserCanceled: return "errSecUserCanceled"
    case errSecItemNotFound: return "errSecItemNotFound"
    case errSecDuplicateItem: return "errSecDuplicateItem"
    default: return "OSStatus"
    }
}

private func fail(_ message: String, _ status: OSStatus? = nil, code: Int32 = 1) -> Never {
    if let status {
        FileHandle.standardError.write(Data("qlb-keychain-helper: \(message) (\(statusName(status)), status \(status))\n".utf8))
    } else {
        FileHandle.standardError.write(Data("qlb-keychain-helper: \(message)\n".utf8))
    }
    exit(code)
}

private func readPayload() -> Data {
    let value = FileHandle.standardInput.readDataToEndOfFile()
    guard value.count <= maxPayloadBytes else { fail("payload exceeds 64 KiB") }
    return value
}

private var selectedKeychain: SecKeychain?

private func query(_ service: String, _ account: String) -> [CFString: Any] {
    var attributes: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
    ]
    if let selectedKeychain {
        attributes[kSecMatchSearchList] = [selectedKeychain] as CFArray
    }
    return attributes
}

private func helperExecutablePath() -> String {
    Bundle.main.executablePath ?? CommandLine.arguments[0]
}

private func trustedAccess(_ service: String) -> SecAccess {
    var securityApplication: SecTrustedApplication?
    var helperApplication: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath("/usr/bin/security", &securityApplication) == errSecSuccess,
          SecTrustedApplicationCreateFromPath(helperExecutablePath(), &helperApplication) == errSecSuccess,
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

private func create(_ itemQuery: [CFString: Any], _ service: String, _ data: Data) -> OSStatus {
    var attributes = itemQuery
    attributes.removeValue(forKey: kSecMatchSearchList)
    if let selectedKeychain { attributes[kSecUseKeychain] = selectedKeychain }
    attributes[kSecValueData] = data
    attributes[kSecAttrAccess] = trustedAccess(service)
    return SecItemAdd(attributes as CFDictionary, nil)
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

    let addStatus = create(itemQuery, service, data)
    if addStatus == errSecDuplicateItem {
        let retryStatus = SecItemUpdate(itemQuery as CFDictionary, [kSecValueData: data] as CFDictionary)
        guard retryStatus == errSecSuccess else { fail("racing update failed", retryStatus) }
        return
    }
    guard addStatus == errSecSuccess else { fail("add failed", addStatus) }
}

private func setIfSha256(_ service: String, _ account: String, _ expectedSha256: String, _ data: Data) {
    guard expectedSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
        fail("--if-sha256 requires a lowercase SHA-256 hex digest")
    }
    var lookup = query(service, account)
    // Ask for the bytes to hash and the record identity/version used by the update
    // query. Apple documents these return attributes for SecItemCopyMatching:
    // https://developer.apple.com/documentation/security/secitemcopymatching(_:_:)
    lookup[kSecReturnData] = true
    lookup[kSecReturnAttributes] = true
    lookup[kSecReturnPersistentRef] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    guard status == errSecSuccess,
          let attributes = result as? [String: Any],
          var stored = attributes[kSecValueData as String] as? Data,
          let modificationDate = attributes[kSecAttrModificationDate as String],
          let persistentRef = attributes[kSecValuePersistentRef as String] else {
        // Only absence is a CAS conflict. A denied or unreadable item is an error.
        fail("compare-and-swap lookup failed", status, code: status == errSecItemNotFound ? 3 : 1)
    }
    defer { stored.resetBytes(in: 0..<stored.count) }
    let actualSha256 = SHA256.hash(data: stored).map { String(format: "%02x", $0) }.joined()
    guard actualSha256 == expectedSha256 else { fail("changed", code: 3) }
    // Match both the exact record and its observed version. SecItemUpdate matches
    // its query (Apple: https://developer.apple.com/documentation/security/secitemupdate(_:_:));
    // modification date is a Keychain item attribute (Apple:
    // https://developer.apple.com/documentation/security/ksecattrmodificationdate).
    // Therefore a writer that changes the record between copy and update makes the
    // query miss, so the helper reports a conflict without overwriting it.
    var casQuery = query(service, account)
    casQuery[kSecAttrModificationDate] = modificationDate
    casQuery[kSecValuePersistentRef] = persistentRef
    let updateStatus = SecItemUpdate(casQuery as CFDictionary, [kSecValueData: data] as CFDictionary)
    if updateStatus == errSecItemNotFound { fail("changed", code: 3) }
    guard updateStatus == errSecSuccess else { fail("compare-and-swap update failed", updateStatus) }
}

/** Reads a protected item solely to authorize this helper. It never prints or writes its data. */
private func probeRead(_ service: String, _ account: String) {
    var lookup = query(service, account)
    lookup[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    guard status == errSecSuccess, var payload = result as? Data else {
        fail("probe read failed", status, code: status == errSecItemNotFound ? 4 : 1)
    }
    defer { payload.resetBytes(in: 0..<payload.count) }
}

private func read(_ service: String, _ account: String) -> (status: OSStatus, data: Data?) {
    var lookup = query(service, account)
    lookup[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    return (status, result as? Data)
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
    let readback = read(service, account)
    guard readback.status == errSecSuccess, let roundTrip = readback.data, roundTrip == payload else {
        fail("selftest readback failed", readback.status)
    }
}

private struct CommandResult {
    let status: Int32
    let output: String
    let timedOut: Bool
}

private typealias MatrixCase = String
private let notApplicable = "not-applicable"

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

private func modificationDate(_ service: String, _ account: String) -> (result: CommandResult, value: String?) {
    let result = run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service])
    let value = result.output.split(separator: "\n").first { $0.contains("\"mdat\"") }.map(String.init)
    return (result, value)
}

private func promptStatus(_ status: OSStatus) -> Bool {
    status == errSecAuthFailed || status == errSecInteractionNotAllowed || status == errSecUserCanceled ||
        status == -25293 || status == -25308 || status == -128
}

private func promptFailure(_ result: CommandResult) -> Bool {
    result.timedOut || result.output.contains("errSecAuthFailed") || result.output.contains("errSecInteractionNotAllowed") ||
        result.output.contains("errSecUserCanceled") || result.output.contains("status -25293") ||
        result.output.contains("status -25308") || result.output.contains("status -128")
}

private func matrix(_ prefix: String, previousHelper: String? = nil) {
    guard prefix.hasPrefix("qlb-test-") else { fail("matrix requires a qlb-test-* prefix") }
    let account = "qlb"
    let marker = Data("matrix-\(UUID().uuidString)".utf8)
    let suffix = UUID().uuidString.lowercased()
    let services = ["\(prefix)security-\(suffix)", "\(prefix)untrusted-\(suffix)", "\(prefix)previous-\(suffix)", "\(prefix)helper-\(suffix)"]
    var cases: [String: MatrixCase] = ["securityCreated": "fail", "securityUntrusted": "fail", "previousHelper": "fail", "helperCreated": "fail"]
    var casePrompted: [String: Bool] = ["securityCreated": false, "securityUntrusted": false, "previousHelper": false, "helperCreated": false]
    var caseReasons: [String: Any] = ["securityCreated": NSNull(), "securityUntrusted": NSNull(), "previousHelper": NSNull(), "helperCreated": NSNull()]
    var prompted = false
    defer { for service in services { _ = run("/usr/bin/security", ["delete-generic-password", "-a", account, "-s", service]) } }

    let securityCreated = run("/usr/bin/security", ["add-generic-password", "-a", account, "-s", services[0], "-w", String(data: marker, encoding: .utf8)!, "-T", helperExecutablePath()])
    let securityUpdate = securityCreated.status == 0 ? run(helperExecutablePath(), ["set", services[0], account], input: marker) : securityCreated
    casePrompted["securityCreated"] = promptFailure(securityCreated) || promptFailure(securityUpdate)
    prompted = casePrompted["securityCreated"]!
    if securityCreated.status == 0 && securityUpdate.status == 0 { cases["securityCreated"] = "pass" }

    let securityUntrusted = run("/usr/bin/security", ["add-generic-password", "-a", account, "-s", services[1], "-w", String(data: marker, encoding: .utf8)!])
    let untrustedMdatBefore = securityUntrusted.status == 0 ? modificationDate(services[1], account) : (result: securityUntrusted, value: nil)
    let untrustedUpdate = securityUntrusted.status == 0 ? run(helperExecutablePath(), ["set", services[1], account], input: Data("matrix-update-\(UUID().uuidString)".utf8)) : securityUntrusted
    let untrustedMdatAfter = securityUntrusted.status == 0 ? modificationDate(services[1], account) : (result: securityUntrusted, value: nil)
    casePrompted["securityUntrusted"] = promptFailure(securityUntrusted) || promptFailure(untrustedUpdate)
    if securityUntrusted.status == 0 {
        if untrustedMdatBefore.result.status != 0 {
            caseReasons["securityUntrusted"] = "could not read mdat before update"
        } else if untrustedMdatAfter.result.status != 0 {
            caseReasons["securityUntrusted"] = "could not read mdat after update"
        } else if untrustedMdatBefore.value == nil {
            caseReasons["securityUntrusted"] = "missing mdat before update"
        } else if untrustedMdatAfter.value == nil {
            caseReasons["securityUntrusted"] = "missing mdat after update"
        } else if untrustedUpdate.status == 0 {
            caseReasons["securityUntrusted"] = "untrusted update unexpectedly succeeded"
        } else if untrustedUpdate.status != 0 && untrustedMdatBefore.value == untrustedMdatAfter.value {
            cases["securityUntrusted"] = "pass"
        } else {
            caseReasons["securityUntrusted"] = "item modified during refused update"
        }
    }

    let previous = previousHelper ?? (NSHomeDirectory() as NSString).appendingPathComponent(".qlb/helper-prev/qlb-keychain-helper")
    if !FileManager.default.isExecutableFile(atPath: previous) {
        cases["previousHelper"] = notApplicable
        caseReasons["previousHelper"] = "no previous helper"
    } else {
        let previousCreate = run(previous, ["set", services[2], account], input: marker)
        let currentUpdate = previousCreate.status == 0 ? run(helperExecutablePath(), ["set", services[2], account], input: marker) : previousCreate
        casePrompted["previousHelper"] = promptFailure(previousCreate) || promptFailure(currentUpdate)
        prompted = prompted || casePrompted["previousHelper"]!
        if previousCreate.status == 0 && currentUpdate.status == 0 { cases["previousHelper"] = "pass" }
    }

    let helperCreate = run(helperExecutablePath(), ["set", services[3], account], input: marker)
    let securityRead = helperCreate.status == 0 ? run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", services[3], "-w"]) : helperCreate
    casePrompted["helperCreated"] = promptFailure(helperCreate) || promptFailure(securityRead)
    prompted = prompted || casePrompted["helperCreated"]!
    if helperCreate.status == 0 && securityRead.status == 0 && Data(securityRead.output.trimmingCharacters(in: .newlines).utf8) == marker {
        cases["helperCreated"] = "pass"
    }

    let result: [String: Any] = ["cases": cases, "casePrompted": casePrompted, "caseReasons": caseReasons, "prompted": prompted]
    let json = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
    if prompted || cases.values.contains("fail") { exit(1) }
}

var args = Array(CommandLine.arguments.dropFirst())
if args.first == "--keychain" {
    guard args.count >= 3 else { fail("--keychain requires a path") }
    var keychain: SecKeychain?
    guard SecKeychainOpen(args[1], &keychain) == errSecSuccess, let keychain else {
        fail("could not open requested keychain")
    }
    selectedKeychain = keychain
    args.removeFirst(2)
}

switch (args.count, args.first) {
case (3, "set"):
    var payload = readPayload()
    defer { payload.resetBytes(in: 0..<payload.count) }
    set(args[1], args[2], payload)
case (5, "set") where args[1] == "--if-sha256":
    var payload = readPayload()
    defer { payload.resetBytes(in: 0..<payload.count) }
    setIfSha256(args[3], args[4], args[2], payload)
case (3, "probe-read"):
    probeRead(args[1], args[2])
case (3, "delete"):
    delete(args[1], args[2])
case (2, "selftest"):
    selftest(args[1])
case (2, "matrix"):
    matrix(args[1])
case (3, "matrix"):
    matrix(args[1], previousHelper: args[2])
default:
    FileHandle.standardError.write(Data("usage: qlb-keychain-helper [--keychain <path>] set [--if-sha256 <hex>] <service> <account> | probe-read|delete <service> <account> | selftest <qlb-test-service> | matrix <qlb-test-prefix> [previous-helper]\n".utf8))
    exit(2)
}
