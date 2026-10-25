import Foundation
import Security

private let maxPayloadBytes = 64 * 1024

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
    guard status == errSecSuccess else { fail("delete failed", status) }
}

private func selftest(_ service: String) {
    guard service.hasPrefix("qlb-test-") else { fail("selftest requires a qlb-test-* service") }
    let account = "qlb"
    let payload = Data(UUID().uuidString.utf8)
    set(service, account, payload)
    var lookup = query(service, account)
    lookup[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    defer { if let result { CFRelease(result) } }
    guard status == errSecSuccess, let roundTrip = result as? Data, roundTrip == payload else {
        fail("selftest readback failed", status)
    }
    delete(service, account)
}

private func matrix(_ prefix: String) {
    guard prefix.hasPrefix("qlb-test-") else { fail("matrix requires a qlb-test-* prefix") }
    // The launchd command supplies the surrounding security-created-item cases.
    // This helper proves its own create/update/read/cleanup path without output.
    selftest("\(prefix)\(UUID().uuidString.lowercased())")
}

let args = Array(CommandLine.arguments.dropFirst())
switch args {
case ["set", let service, let account]:
    var payload = readPayload()
    defer { payload.resetBytes(in: 0..<payload.count) }
    set(service, account, payload)
case ["delete", let service, let account]:
    delete(service, account)
case ["selftest", let service]:
    selftest(service)
case ["matrix", let prefix]:
    matrix(prefix)
default:
    FileHandle.standardError.write(Data("usage: qlb-keychain-helper set|delete <service> <account> | selftest <qlb-test-service> | matrix <qlb-test-prefix>\n".utf8))
    exit(2)
}
