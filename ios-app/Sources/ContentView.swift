import SwiftUI
import AVFoundation

@main
struct LensLinkWebcamApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var discovery = LocalNetworkDiscovery()
    @StateObject private var camera = CameraCaptureManager()
    @State private var connectedPC: DiscoveredWindowsPC?

    var body: some View {
        ZStack {
            if let pc = connectedPC {
                VStack(spacing: 12) {
                    HStack {
                        Text(pc.pcName)
                            .font(.headline)
                            .foregroundColor(.white)
                        Spacer()
                        Text("\(camera.activeResolution.rawValue) · \(camera.targetFps) FPS · \(camera.batteryPercent)%")
                            .font(.caption.monospacedDigit())
                            .foregroundColor(.white.opacity(0.85))
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)

                    Spacer()

                    HStack(spacing: 14) {
                        Button(camera.torchEnabled ? "Flash On" : "Flash") {
                            camera.setTorch(!camera.torchEnabled)
                        }
                        Button(camera.isDimmed ? "Wake" : "Dim Screen") {
                            camera.isDimmed.toggle()
                        }
                        Button("Disconnect") {
                            connectedPC = nil
                        }
                        .foregroundColor(.red)
                    }
                    .padding()
                    .background(.ultraThinMaterial)
                    .cornerRadius(14)
                    .padding(.bottom, 24)
                }
                .background(Color.black.ignoresSafeArea())

                if camera.isDimmed {
                    Color.black.opacity(0.96)
                        .ignoresSafeArea()
                        .overlay(
                            Text("LensLink Streaming Active — Tap anywhere to brighten")
                                .font(.footnote)
                                .foregroundColor(.white.opacity(0.45))
                        )
                        .onTapGesture { camera.isDimmed = false }
                }
            } else {
                NavigationView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Status: \(discovery.status)")
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(Color(red: 0.11, green: 0.31, blue: 0.85))

                        if discovery.discoveredPCs.isEmpty {
                            Text("Keep your iPhone and Windows PC on the same Wi-Fi network. Your PC will appear here automatically.")
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        } else {
                            List(discovery.discoveredPCs) { pc in
                                Button {
                                    connectedPC = pc
                                    camera.startCamera()
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(pc.pcName).font(.headline)
                                            Text("Tap to connect wirelessly").font(.caption).foregroundColor(.secondary)
                                        }
                                        Spacer()
                                        Text("Connect")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundColor(Color(red: 0.11, green: 0.31, blue: 0.85))
                                    }
                                }
                            }
                            .listStyle(.insetGrouped)
                        }
                        Spacer()
                    }
                    .padding()
                    .navigationTitle("LensLink Webcam")
                }
                .onAppear { discovery.start() }
            }
        }
    }
}
