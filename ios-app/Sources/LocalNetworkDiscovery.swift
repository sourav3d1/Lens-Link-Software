import Foundation
import Network

struct DiscoveredWindowsPC: Identifiable, Hashable {
    let id: String
    let pcName: String
    let roomCode: String
    let endpoint: NWEndpoint
}

final class LocalNetworkDiscovery: ObservableObject {
    @Published var discoveredPCs: [DiscoveredWindowsPC] = []
    @Published var status: String = "Searching"

    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "com.lenslink.bonjour.discovery")

    func start() {
        stop()
        status = "Searching"
        let params = NWParameters()
        params.includePeerToPeer = true
        let descriptor = NWBrowser.Descriptor.bonjour(type: "_lenslink-webcam._tcp", domain: "local.")
        let browser = NWBrowser(for: descriptor, using: params)

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            var pcs: [DiscoveredWindowsPC] = []
            for result in results {
                if case let .service(name, _, _, _) = result.endpoint {
                    var roomCode = ""
                    var pcName = name
                    if case let .bonjour(txt) = result.metadata {
                        if let parsedName = txt["pcName"] { pcName = parsedName }
                        if let parsedCode = txt["roomCode"] { roomCode = parsedCode }
                    }
                    pcs.append(
                        DiscoveredWindowsPC(
                            id: name,
                            pcName: pcName,
                            roomCode: roomCode,
                            endpoint: result.endpoint
                        )
                    )
                }
            }
            DispatchQueue.main.async {
                self?.discoveredPCs = pcs
                self?.status = pcs.isEmpty ? "Searching" : "Device Found"
            }
        }

        browser.start(queue: queue)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }
}
