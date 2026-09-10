import SwiftUI

struct LauncherConfiguration: Decodable {
    let serviceURL: URL
    let credentialProvider: String

    static func load() throws -> Self {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/Camofox/LauncherConfig.json")
        let data = try Data(contentsOf: url)
        let configuration = try JSONDecoder().decode(Self.self, from: data)
        guard configuration.serviceURL.scheme == "http",
              configuration.serviceURL.host == "127.0.0.1",
              configuration.serviceURL.user == nil,
              configuration.serviceURL.password == nil,
              !configuration.credentialProvider.isEmpty else {
            throw LauncherError.configuration("Launcher configuration must use a loopback service and credential provider.")
        }
        guard FileManager.default.isExecutableFile(atPath: configuration.credentialProvider) else {
            throw LauncherError.configuration("Camofox credential provider is unavailable.")
        }
        return configuration
    }
}

struct Identity: Codable, Identifiable, Hashable {
    let alias: String
    let userId: String
    let displayName: String
    var id: String { userId }
}
struct IdentityList: Decodable { let identities: [Identity] }
struct Tab: Codable, Identifiable, Hashable {
    let tabId: String
    let title: String?
    let url: String?
    var id: String { tabId }
}
struct TabList: Decodable { let tabs: [Tab] }
struct OpenResult: Decodable { let tabId: String? }

private final class RedirectRefusingDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private final class ProcessCollectionState: @unchecked Sendable {
    private let lock = NSLock()
    private let outputLimit: Int
    private var output = Data()
    private var process: Process?
    private var outputHandle: FileHandle?
    private var continuation: CheckedContinuation<String, Error>?
    private var terminalResult: Result<String, Error>?
    private var timeoutTask: Task<Void, Never>?

    init(outputLimit: Int) { self.outputLimit = outputLimit }

    func begin(_ continuation: CheckedContinuation<String, Error>) {
        lock.lock()
        if let terminalResult {
            lock.unlock()
            continuation.resume(with: terminalResult)
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func attach(process: Process, outputHandle: FileHandle) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard terminalResult == nil else { return false }
        self.process = process
        self.outputHandle = outputHandle
        return true
    }

    func setTimeout(_ task: Task<Void, Never>) {
        lock.lock()
        if terminalResult == nil { timeoutTask = task } else { task.cancel() }
        lock.unlock()
    }

    func append(_ data: Data) {
        lock.lock()
        guard terminalResult == nil else { lock.unlock(); return }
        guard output.count + data.count <= outputLimit else {
            lock.unlock()
            finish(.failure(LauncherError.configuration("Camofox credential provider is unavailable.")), terminate: true)
            return
        }
        output.append(data)
        lock.unlock()
    }

    func processExited(_ process: Process) {
        let remainder = outputHandle?.readDataToEndOfFile() ?? Data()
        append(remainder)
        lock.lock()
        guard terminalResult == nil else { lock.unlock(); return }
        let token = String(data: output, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        lock.unlock()
        guard process.terminationStatus == 0, let token, !token.isEmpty else {
            finish(.failure(LauncherError.configuration("Camofox credential provider is unavailable.")), terminate: false)
            return
        }
        finish(.success(token), terminate: false)
    }

    func timeout() {
        finish(.failure(LauncherError.configuration("Camofox credential provider is unavailable.")), terminate: true)
    }

    func cancel() {
        finish(.failure(CancellationError()), terminate: true)
    }

    private func finish(_ result: Result<String, Error>, terminate: Bool) {
        lock.lock()
        guard terminalResult == nil else { lock.unlock(); return }
        terminalResult = result
        let continuation = self.continuation
        self.continuation = nil
        let process = self.process
        let outputHandle = self.outputHandle
        self.outputHandle = nil
        let timeoutTask = self.timeoutTask
        self.timeoutTask = nil
        lock.unlock()

        timeoutTask?.cancel()
        outputHandle?.readabilityHandler = nil
        if terminate, process?.isRunning == true { process?.terminate() }
        continuation?.resume(with: result)
    }
}

enum CredentialProvider {
    static let timeout: Duration = .seconds(5)
    static let maximumOutputBytes = 4 * 1024

    nonisolated static func token(
        executablePath: String,
        timeout: Duration = CredentialProvider.timeout,
        outputLimit: Int = CredentialProvider.maximumOutputBytes
    ) async throws -> String {
        let state = ProcessCollectionState(outputLimit: outputLimit)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                state.begin(continuation)
                let process = Process()
                let output = Pipe()
                process.executableURL = URL(fileURLWithPath: executablePath)
                process.standardOutput = output
                process.standardError = FileHandle.nullDevice
                output.fileHandleForReading.readabilityHandler = { handle in
                    state.append(handle.availableData)
                }
                process.terminationHandler = { process in state.processExited(process) }
                guard state.attach(process: process, outputHandle: output.fileHandleForReading) else { return }
                do {
                    try process.run()
                    let timeoutTask = Task.detached {
                        try? await Task.sleep(for: timeout)
                        if !Task.isCancelled { state.timeout() }
                    }
                    state.setTimeout(timeoutTask)
                } catch {
                    state.timeout()
                }
            }
        }, onCancel: {
            state.cancel()
        })
    }
}

enum LauncherError: LocalizedError {
    case configuration(String), service(String)
    var errorDescription: String? {
        switch self { case .configuration(let message), .service(let message): return message }
    }
}

@MainActor final class LauncherModel: ObservableObject {
    @Published var identities: [Identity] = []
    @Published var selectedIdentity: Identity?
    @Published var tabs: [Tab] = []
    @Published var selectedTab: Tab?
    @Published var error: String?
    @Published var loading = false
    private var configuration: LauncherConfiguration?
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration, delegate: RedirectRefusingDelegate(), delegateQueue: nil)
        }
    }

    func refresh() async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let config = try LauncherConfiguration.load()
            configuration = config
            identities = try await request("/browser/identities", config: config, method: "GET", body: Optional<String>.none, response: IdentityList.self).identities
            if let selectedIdentity, !identities.contains(selectedIdentity) {
                self.selectedIdentity = nil
                tabs = []
                selectedTab = nil
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func open(_ identity: Identity) async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let config = try configured()
            selectedIdentity = identity
            let openResult = try await request("/browser/identities/\(identity.userId)/open", config: config, method: "POST", body: Optional<String>.none, response: OpenResult.self)
            let loadedTabs = try await request("/tabs?userId=\(identity.userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? identity.userId)", config: config, method: "GET", body: Optional<String>.none, response: TabList.self).tabs
            tabs = loadedTabs
            selectedTab = openResult.tabId.flatMap { openedTabID in loadedTabs.first { $0.tabId == openedTabID } }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func handoff(_ handoff: String) async {
        guard !loading, let identity = selectedIdentity, let tab = selectedTab else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let config = try configured()
            struct Handoff: Encodable { let userId: String; let handoff: String }
            _ = try await request("/tabs/\(tab.tabId)/handoff", config: config, method: "POST", body: Handoff(userId: identity.userId, handoff: handoff), response: OpenResult.self)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func configured() throws -> LauncherConfiguration {
        if let configuration { return configuration }
        let loaded = try LauncherConfiguration.load()
        configuration = loaded
        return loaded
    }

    private nonisolated func request<Request: Encodable, Response: Decodable>(_ path: String, config: LauncherConfiguration, method: String, body: Request?, response: Response.Type) async throws -> Response {
        guard let url = URL(string: path, relativeTo: config.serviceURL) else {
            throw LauncherError.configuration("Launcher service URL is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(try await CredentialProvider.token(executablePath: config.credentialProvider))", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw LauncherError.service("Camofox service request failed.")
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw LauncherError.service("Camofox service returned an invalid response.")
        }
    }
}

struct ContentView: View {
    @StateObject private var model = LauncherModel()
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Camofox").font(.title2.weight(.semibold))
                Spacer()
                Button("Refresh") { Task { await model.refresh() } }.disabled(model.loading)
            }
            if model.selectedIdentity == nil {
                Text("Choose a shared browser profile.").foregroundStyle(.secondary)
                List(model.identities, selection: $model.selectedIdentity) { identity in
                    Button { Task { await model.open(identity) } } label: {
                        VStack(alignment: .leading) {
                            Text(identity.displayName)
                            Text(identity.alias).font(.caption).foregroundStyle(.secondary)
                        }
                    }.buttonStyle(.plain).disabled(model.loading)
                }.disabled(model.loading).frame(minHeight: 170)
            } else {
                HStack {
                    Button("‹ Profiles") {
                        model.selectedIdentity = nil
                        model.tabs = []
                        model.selectedTab = nil
                    }.disabled(model.loading)
                    Text(model.selectedIdentity!.displayName).font(.headline)
                }
                List(model.tabs, selection: $model.selectedTab) { tab in
                    VStack(alignment: .leading) {
                        Text(tab.title ?? "Untitled tab").lineLimit(1)
                        Text(tab.url ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }.disabled(model.loading).frame(minHeight: 150)
                HStack {
                    Button("Take Control") { Task { await model.handoff("human") } }
                        .disabled(model.selectedTab == nil || model.loading)
                    Button("Return to Agent") { Task { await model.handoff("agent") } }
                        .disabled(model.selectedTab == nil || model.loading)
                }
            }
        }
        .padding(18)
        .frame(width: 380, height: 300)
        .task { await model.refresh() }
        .alert("Camofox", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(model.error ?? "") }
    }
}

@main struct CamofoxLauncherApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }.windowResizability(.contentSize)
    }
}
