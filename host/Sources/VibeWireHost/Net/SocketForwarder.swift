import Foundation
import Darwin

/// The host's front door: a plain POSIX listening socket that splices every
/// connection into the real server on loopback.
///
/// This exists for one reason. `NWListener` does not accept connections that
/// arrive on Tailscale's `utun` interface on macOS. That was established by
/// elimination, not by guesswork:
///
///   - wildcard `NWListener`            → LAN yes, Tailscale no, loopback yes
///   - `requiredLocalEndpoint` wildcard → same
///   - `requiredInterface = utun5`, the exact interface holding the 100.x
///     address, listener reporting `.ready` → still nothing arrives
///   - `python3 -m http.server` on `0.0.0.0`, same machine, same moment
///     → reachable on all three
///
/// A BSD socket sees the traffic; Network.framework does not. Rather than
/// rewrite `Connection` and the WebSocket layer — both of which are built on
/// `NWConnection` and work perfectly well — the socket is put in front and the
/// bytes are copied through. One extra copy per direction, which at 6 Mbps of
/// H.264 is nothing next to the encode.
///
/// The socket is dual-stack (`IPV6_V6ONLY` off) because a Tailscale node has
/// both a 100.x address and an IPv6 one, and either may be what the phone dials.
final class SocketForwarder {
    private let listenPort: UInt16
    private let targetPort: UInt16
    private let queue = DispatchQueue(label: "vibewire.forwarder", attributes: .concurrent)

    private var listenSocket: Int32 = -1
    private var acceptSource: DispatchSourceRead?

    init(listenPort: UInt16, targetPort: UInt16) {
        self.listenPort = listenPort
        self.targetPort = targetPort
    }

    func start() throws {
        let fd = socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP)
        guard fd >= 0 else { throw HostError.forwarderFailed("socket: \(errno)") }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        // Accept IPv4 as well, mapped into the v6 socket. Without this the
        // 100.x address — the one that matters here — cannot connect.
        var no: Int32 = 0
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &no, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in6()
        address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        address.sin6_family = sa_family_t(AF_INET6)
        address.sin6_port = listenPort.bigEndian
        address.sin6_addr = in6addr_any

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
        guard bound == 0 else {
            let failure = errno
            close(fd)
            throw HostError.forwarderFailed("bind \(listenPort): \(String(cString: strerror(failure)))")
        }

        guard listen(fd, 64) == 0 else {
            let failure = errno
            close(fd)
            throw HostError.forwarderFailed("listen: \(String(cString: strerror(failure)))")
        }

        listenSocket = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptOne() }
        source.setCancelHandler { close(fd) }
        source.resume()
        acceptSource = source

        Log.info(.net, "front door open on port \(listenPort) (all interfaces)")
    }

    func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        listenSocket = -1
    }

    private func acceptOne() {
        var remote = sockaddr_storage()
        var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let client = withUnsafeMutablePointer(to: &remote) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                accept(listenSocket, $0, &length)
            }
        }
        guard client >= 0 else { return }

        queue.async { [targetPort] in
            guard let upstream = Self.connectLoopback(port: targetPort) else {
                close(client)
                return
            }
            Self.splice(client, upstream)
        }
    }

    /// Dials the real server. Loopback only — the forwarder is the sole public
    /// entrance, and the `NWListener` behind it never needs to be exposed.
    private static func connectLoopback(port: UInt16) -> Int32? {
        let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard fd >= 0 else { return nil }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else {
            Log.error(.net, "front door could not reach the server on 127.0.0.1:\(port)")
            close(fd)
            return nil
        }

        var yes: Int32 = 1
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }

    /// Copies bytes both ways until either end goes quiet, then closes both.
    ///
    /// Two dedicated threads rather than dispatch sources: the pump is a blocking
    /// read/write loop, which is the simplest thing that cannot lose a partial
    /// write, and there is exactly one pair of them per connected phone.
    private static func splice(_ a: Int32, _ b: Int32) {
        let done = DispatchGroup()
        let shutdownOnce = Guarded(false)

        func teardown() {
            let first = shutdownOnce.withLock { closed -> Bool in
                if closed { return false }
                closed = true
                return true
            }
            guard first else { return }
            shutdown(a, SHUT_RDWR)
            shutdown(b, SHUT_RDWR)
        }

        func pump(from source: Int32, to sink: Int32) {
            let size = 64 * 1024
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            defer { buffer.deallocate() }

            while true {
                let read = recv(source, buffer, size, 0)
                guard read > 0 else { break }

                var written = 0
                while written < read {
                    let sent = send(sink, buffer + written, read - written, 0)
                    guard sent > 0 else { return teardown() }
                    written += sent
                }
            }
            teardown()
        }

        DispatchQueue.global(qos: .userInitiated).async(group: done) { pump(from: a, to: b) }
        DispatchQueue.global(qos: .userInitiated).async(group: done) { pump(from: b, to: a) }

        done.notify(queue: .global()) {
            close(a)
            close(b)
        }
    }
}
