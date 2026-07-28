import Foundation
import os

/// A small mutex around a value.
///
/// Why not `NSLock` directly: Swift 6 marks `NSLock.lock()` unavailable from
/// async contexts, and most of the call sites here sit inside `async`
/// functions. Why not `OSAllocatedUnfairLock<State>`: its `withLock` requires
/// both the state and the result to be `Sendable`, which they are not — the
/// guarded state holds live `ScreenStream` and `SocketConnection` references.
///
/// So: a raw `os_unfair_lock` behind synchronous, scoped accessors. The
/// accessors are not `async`, so taking the lock inside them is legal, and the
/// scoped shape means the lock is always released on the path that took it and
/// no `await` can appear while it is held.
///
/// The pointer allocation is deliberate: `os_unfair_lock` must never be copied,
/// and storing it as a stored property risks exactly that.
final class Guarded<Value>: @unchecked Sendable {
    private var value: Value
    private let lock: UnsafeMutablePointer<os_unfair_lock>

    init(_ value: Value) {
        self.value = value
        self.lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        self.lock.initialize(to: os_unfair_lock())
    }

    deinit {
        lock.deinitialize(count: 1)
        lock.deallocate()
    }

    /// Mutating access. Keep the body short and free of I/O.
    @discardableResult
    func withLock<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        return try body(&value)
    }

    /// Read a snapshot without mutating.
    func read<Result>(_ body: (Value) throws -> Result) rethrows -> Result {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        return try body(value)
    }
}
