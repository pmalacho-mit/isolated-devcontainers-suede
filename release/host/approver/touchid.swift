// desolate's approver on a Mac: a signing key that lives in the Secure Enclave and signs
// only when the person at this Mac is present (Touch ID, or the login password where there
// is no sensor). host/approver.ts compiles this once, at bootstrap, with `swiftc`.
//
//   desolate-touchid init <keyfile>            make the key; print its public key (PEM)
//   desolate-touchid sign <keyfile> <reason>   sign stdin; print the signature (DER, base64)
//
// The key file holds the Secure Enclave's wrapped handle to the key, not key material: it
// is useless on any other Mac, and useless on this one without the person. No process can
// export the private key, this one included.
//
// NOT YET RUN ON A MAC (it was written on Linux): see docs/v3/HANDOFF.md, tier T4.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(("desolate-touchid: " + message + "\n").data(using: .utf8)!)
  exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { fail("usage: desolate-touchid init <keyfile> | sign <keyfile> <reason>", 64) }
let keyFile = URL(fileURLWithPath: arguments[2])

do {
  switch arguments[1] {
  case "init":
    guard SecureEnclave.isAvailable else { fail("this Mac has no Secure Enclave", 78) }
    var error: Unmanaged<CFError>?
    // userPresence: Touch ID, with the login password as the fallback macOS offers. Either
    // is something a program running as this user does not have.
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
      fail("could not describe the key's access control: \(String(describing: error?.takeRetainedValue()))", 1)
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    try key.dataRepresentation.write(to: keyFile, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyFile.path)
    print(key.publicKey.pemRepresentation)
  case "sign":
    guard arguments.count >= 4 else { fail("sign needs a reason to show the person", 64) }
    let context = LAContext()
    context.localizedReason = arguments[3]
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: try Data(contentsOf: keyFile), authenticationContext: context)
    let message = FileHandle.standardInput.readDataToEndOfFile()
    // ECDSA over SHA-256 of the message: what node's verify("sha256", ...) checks.
    let signature = try key.signature(for: message)
    print(signature.derRepresentation.base64EncodedString())
  default:
    fail("unknown command '\(arguments[1])'", 64)
  }
} catch {
  // A cancelled prompt lands here. No signature is printed, so nothing is approved.
  fail("\(error.localizedDescription)", 78)
}
