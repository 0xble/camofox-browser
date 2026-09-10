import Foundation
import XCTest
@testable import CamofoxLauncher

final class CredentialProviderTests: XCTestCase {
    private func provider(_ body: String) throws -> String {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("camofox-credential-provider-\(UUID().uuidString)")
        try "#!/bin/sh\n\(body)\n".write(to: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: path) }
        return path.path
    }

    func testHangingProviderTimesOutAndDoesNotExposeOutput() async throws {
        let executable = try provider("echo secret-that-must-not-escape; sleep 30")
        do {
            _ = try await CredentialProvider.token(executablePath: executable, timeout: .milliseconds(100))
            XCTFail("expected timeout")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Camofox credential provider is unavailable.")
            XCTAssertFalse(error.localizedDescription.contains("secret-that-must-not-escape"))
        }
    }

    func testLargeProviderOutputFailsClosedWithoutReturningIt() async throws {
        let executable = try provider("head -c 8192 /dev/zero | tr '\\0' x")
        do {
            _ = try await CredentialProvider.token(executablePath: executable, timeout: .seconds(2))
            XCTFail("expected output cap failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Camofox credential provider is unavailable.")
        }
    }

    func testCancellationTerminatesProvider() async throws {
        let executable = try provider("while :; do :; done")
        let task = Task {
            try await CredentialProvider.token(executablePath: executable, timeout: .seconds(10))
        }
        try await Task.sleep(for: .milliseconds(100))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch is CancellationError {
            // Expected: cancellation kills the running provider and returns promptly.
        }
    }

    func testNonzeroProviderFailsClosedOffMainActor() async throws {
        let executable = try provider("echo provider-secret; exit 7")
        do {
            _ = try await Task.detached {
                try await CredentialProvider.token(executablePath: executable, timeout: .seconds(2))
            }.value
            XCTFail("expected nonzero exit failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Camofox credential provider is unavailable.")
            XCTAssertFalse(error.localizedDescription.contains("provider-secret"))
        }
    }
}
