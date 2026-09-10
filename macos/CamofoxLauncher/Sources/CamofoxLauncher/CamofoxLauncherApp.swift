import SwiftUI

struct LauncherConfiguration: Decodable {
    let serviceURL: URL
    let credentialProvider: String

    static func load() throws -> Self {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/Camofox/LauncherConfig.json")
        let data = try Data(contentsOf: url)
        let configuration = try JSONDecoder().decode(Self.self, from: data)
        guard configuration.serviceURL.scheme == "http", configuration.serviceURL.host == "127.0.0.1",
              !configuration.credentialProvider.isEmpty else {
            throw LauncherError.configuration("Launcher configuration must use a loopback service and credential provider.")
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
struct APIError: Decodable { let error: String? }

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

    func refresh() async {
        loading = true; defer { loading = false }
        do {
            let config = try LauncherConfiguration.load(); configuration = config
            identities = try await request("/browser/identities", config: config, method: "GET", body: Optional<String>.none, response: IdentityList.self).identities
            if let selectedIdentity, !identities.contains(selectedIdentity) { self.selectedIdentity = nil; tabs = []; selectedTab = nil }
        } catch { self.error = error.localizedDescription }
    }

    func open(_ identity: Identity) async {
        loading = true; defer { loading = false }
        do {
            let config = try configured()
            selectedIdentity = identity
            _ = try await request("/browser/identities/\(identity.userId)/open", config: config, method: "POST", body: Optional<String>.none, response: OpenResult.self)
            tabs = try await request("/tabs?userId=\(identity.userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? identity.userId)", config: config, method: "GET", body: Optional<String>.none, response: TabList.self).tabs
            selectedTab = tabs.first
        } catch { self.error = error.localizedDescription }
    }

    func handoff(_ handoff: String) async {
        guard let identity = selectedIdentity, let tab = selectedTab else { return }
        loading = true; defer { loading = false }
        do {
            let config = try configured()
            struct Handoff: Encodable { let userId: String; let handoff: String }
            _ = try await request("/tabs/\(tab.tabId)/handoff", config: config, method: "POST", body: Handoff(userId: identity.userId, handoff: handoff), response: OpenResult.self)
        } catch { self.error = error.localizedDescription }
    }

    private func configured() throws -> LauncherConfiguration { if let configuration { return configuration }; let loaded = try LauncherConfiguration.load(); configuration = loaded; return loaded }

    private func token(_ config: LauncherConfiguration) throws -> String {
        let process = Process(); process.executableURL = URL(fileURLWithPath: config.credentialProvider)
        let output = Pipe(); process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0, let token = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else { throw LauncherError.configuration("Camofox credential provider is unavailable.") }
        return token
    }

    private func request<Request: Encodable, Response: Decodable>(_ path: String, config: LauncherConfiguration, method: String, body: Request?, response: Response.Type) async throws -> Response {
        var request = URLRequest(url: config.serviceURL.appending(path: path)); request.httpMethod = method
        request.setValue("Bearer \(try token(config))", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, urlResponse) = try await URLSession.shared.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else { throw LauncherError.service("Camofox service returned an invalid response.") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Service request failed (\(http.statusCode))."
            throw LauncherError.service(message)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

struct ContentView: View {
    @StateObject private var model = LauncherModel()
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Camofox").font(.title2.weight(.semibold)); Spacer(); Button("Refresh") { Task { await model.refresh() } }.disabled(model.loading) }
            if model.selectedIdentity == nil {
                Text("Choose a shared browser profile.").foregroundStyle(.secondary)
                List(model.identities, selection: $model.selectedIdentity) { identity in
                    Button { Task { await model.open(identity) } } label: { VStack(alignment: .leading) { Text(identity.displayName); Text(identity.alias).font(.caption).foregroundStyle(.secondary) } }.buttonStyle(.plain)
                }.frame(minHeight: 170)
            } else {
                HStack { Button("‹ Profiles") { model.selectedIdentity = nil; model.tabs = []; model.selectedTab = nil }; Text(model.selectedIdentity!.displayName).font(.headline) }
                List(model.tabs, selection: $model.selectedTab) { tab in VStack(alignment: .leading) { Text(tab.title ?? "Untitled tab").lineLimit(1); Text(tab.url ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1) } }.frame(minHeight: 150)
                HStack { Button("Take Control") { Task { await model.handoff("human") } }.disabled(model.selectedTab == nil || model.loading); Button("Return to Agent") { Task { await model.handoff("agent") } }.disabled(model.selectedTab == nil || model.loading) }
            }
        }.padding(18).frame(width: 380, height: 300).task { await model.refresh() }.alert("Camofox", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(model.error ?? "") }
    }
}

@main struct CamofoxLauncherApp: App { var body: some Scene { WindowGroup { ContentView() }.windowResizability(.contentSize) } }
