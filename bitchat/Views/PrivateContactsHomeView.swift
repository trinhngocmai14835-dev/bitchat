#if os(iOS)
import SwiftUI

/// The focused iOS entry screen for the account-free private-chat build.
/// Contacts are local key-based identities stored by FavoritesPersistenceService;
/// no directory or registration service is involved.
struct PrivateContactsHomeView: View {
    @EnvironmentObject private var appChromeModel: AppChromeModel
    @EnvironmentObject private var privateConversationModel: PrivateConversationModel
    @EnvironmentObject private var verificationModel: VerificationModel
    @ObservedObject private var favorites = FavoritesPersistenceService.shared
    @State private var showingInvite = false
    @State private var openingScanner = false
    @ThemedPalette private var palette

    private var contacts: [FavoritesPersistenceService.FavoriteRelationship] {
        favorites.favorites.values
            .filter { $0.isFavorite && $0.peerNostrPublicKey != nil }
            .sorted { $0.peerNickname.localizedCaseInsensitiveCompare($1.peerNickname) == .orderedAscending }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Spacer()
                    Button {
                        appChromeModel.presentAppInfo()
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.body.weight(.medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(palette.secondary)
                    .accessibilityLabel("settings")
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("private chat")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(palette.primary)
                    Text("no account · invite-only · end-to-end encrypted")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }

                HStack(spacing: 10) {
                    Button {
                        openingScanner = false
                        showingInvite = true
                    } label: {
                        Label("my invite", systemImage: "qrcode")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        openingScanner = true
                        showingInvite = true
                    } label: {
                        Label("add contact", systemImage: "camera.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                if contacts.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "person.badge.plus")
                            .font(.system(size: 34))
                            .foregroundStyle(palette.secondary)
                        Text("no private contacts")
                            .font(.headline)
                        Text("Show your QR code to someone you trust, or scan theirs to start a private chat.")
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(palette.secondary)
                        Button("show QR code") {
                            openingScanner = false
                            showingInvite = true
                        }
                            .buttonStyle(.borderedProminent)
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 50)
                } else {
                    Text("contacts")
                        .font(.headline)
                        .foregroundStyle(palette.primary)

                    LazyVStack(spacing: 0) {
                        ForEach(contacts, id: \.peerNoisePublicKey) { contact in
                            Button {
                                privateConversationModel.startConversation(
                                    with: PeerID(publicKey: contact.peerNoisePublicKey)
                                )
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "person.crop.circle.fill")
                                        .font(.title2)
                                        .foregroundStyle(palette.accent)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(contact.peerNickname.isEmpty ? "contact" : contact.peerNickname)
                                            .font(.body.weight(.medium))
                                        Text(contact.peerNostrPublicKey ?? "")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(palette.secondary)
                                }
                                .padding(.vertical, 13)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    favorites.removeFavorite(peerNoisePublicKey: contact.peerNoisePublicKey)
                                } label: {
                                    Label("remove", systemImage: "trash")
                                }
                            }
                            Divider()
                        }
                    }
                    .padding(.horizontal, 14)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 28)
            .padding(.bottom, 40)
        }
        .sheet(isPresented: $showingInvite) {
            VerificationSheetView(isPresented: $showingInvite, initiallyShowingScanner: openingScanner)
                .environmentObject(verificationModel)
        }
    }
}
#endif
