/**
 * The Win32 calls this host makes, bound through koffi. Loaded lazily and only
 * on Windows; every other platform never touches this file at runtime.
 *
 * Struct layouts are asserted at load: `INPUT` is 40 bytes on x64 and arm64
 * (both LLP64), and a layout mistake here would otherwise be a pointer that
 * moves nowhere with no error to read.
 */
import type koffiType from 'koffi'

type Koffi = typeof koffiType

export const INPUT_MOUSE = 0
export const INPUT_KEYBOARD = 1

export const MOUSEEVENTF_MOVE = 0x0001
export const MOUSEEVENTF_LEFTDOWN = 0x0002
export const MOUSEEVENTF_LEFTUP = 0x0004
export const MOUSEEVENTF_RIGHTDOWN = 0x0008
export const MOUSEEVENTF_RIGHTUP = 0x0010
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020
export const MOUSEEVENTF_MIDDLEUP = 0x0040
export const MOUSEEVENTF_WHEEL = 0x0800
export const MOUSEEVENTF_HWHEEL = 0x1000
export const MOUSEEVENTF_VIRTUALDESK = 0x4000
export const MOUSEEVENTF_ABSOLUTE = 0x8000

export const KEYEVENTF_EXTENDEDKEY = 0x0001
export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004
export const KEYEVENTF_SCANCODE = 0x0008

export const WHEEL_DELTA = 120
export const MAPVK_VK_TO_VSC = 0

export const SM_XVIRTUALSCREEN = 76
export const SM_YVIRTUALSCREEN = 77
export const SM_CXVIRTUALSCREEN = 78
export const SM_CYVIRTUALSCREEN = 79

export const DESKTOP_READOBJECTS = 0x0001
export const UOI_NAME = 2

export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
export const TOKEN_QUERY = 0x0008
export const TOKEN_ELEVATION = 20

export const ES_CONTINUOUS = 0x80000000
export const ES_DISPLAY_REQUIRED = 0x00000002
export const ES_SYSTEM_REQUIRED = 0x00000001

export interface MouseInput {
  dx: number
  dy: number
  mouseData: number
  dwFlags: number
  time: number
  dwExtraInfo: number
}

export interface KeyboardInput {
  wVk: number
  wScan: number
  dwFlags: number
  time: number
  dwExtraInfo: number
}

export type Input = { type: 0; u: { mi: MouseInput } } | { type: 1; u: { ki: KeyboardInput } }

export interface User32 {
  sendInput(inputs: Input[]): number
  getSystemMetrics(index: number): number
  mapVirtualKey(vk: number, mapType: number): number
  lockWorkStation(): boolean
  getForegroundWindow(): unknown
  windowText(hwnd: unknown): string
  windowProcessId(hwnd: unknown): number
  /** The name of the desktop that owns input: "Default" for the user's own,
   *  "Winlogon" for the lock screen and UAC's secure desktop. */
  inputDesktopName(): string | null
  processImagePath(pid: number): string | null
  processIsElevated(pid: number): boolean | null
  setThreadExecutionState(flags: number): number
  getDoubleClickTime(): number
  readonly inputSize: number
}

let cached: User32 | null = null

/** Binds user32/kernel32/advapi32 once. Throws off Windows or when koffi is
 *  not installed, which the caller turns into a named condition. */
export function loadUser32(): User32 {
  if (cached) return cached
  const koffi = require('koffi') as Koffi

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  })
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' })
  const INPUT = koffi.struct('INPUT', {
    type: 'uint32_t',
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  })
  const inputSize = koffi.sizeof(INPUT)
  if (inputSize !== 40) throw new Error(`INPUT is ${inputSize} bytes here, expected 40; refusing to send input with a wrong layout`)

  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const HANDLE = koffi.pointer(koffi.opaque('HANDLE'))

  const SendInput = user32.func('unsigned int __stdcall SendInput(unsigned int cInputs, INPUT *pInputs, int cbSize)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)')
  const MapVirtualKeyW = user32.func('unsigned int __stdcall MapVirtualKeyW(unsigned int uCode, unsigned int uMapType)')
  const LockWorkStation = user32.func('int __stdcall LockWorkStation()')
  const GetForegroundWindow = user32.func('HANDLE __stdcall GetForegroundWindow()')
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(HANDLE hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(HANDLE hWnd, _Out_ uint32_t *lpdwProcessId)')
  const OpenInputDesktop = user32.func('HANDLE __stdcall OpenInputDesktop(uint32_t dwFlags, int fInherit, uint32_t dwDesiredAccess)')
  const CloseDesktop = user32.func('int __stdcall CloseDesktop(HANDLE hDesktop)')
  const GetUserObjectInformationW = user32.func(
    'int __stdcall GetUserObjectInformationW(HANDLE hObj, int nIndex, _Out_ uint16_t *pvInfo, uint32_t nLength, _Out_ uint32_t *lpnLengthNeeded)',
  )
  const GetDoubleClickTime = user32.func('unsigned int __stdcall GetDoubleClickTime()')
  const SetThreadExecutionState = kernel32.func('uint32_t __stdcall SetThreadExecutionState(uint32_t esFlags)')
  const OpenProcess = kernel32.func('HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)')
  const CloseHandle = kernel32.func('int __stdcall CloseHandle(HANDLE hObject)')
  const QueryFullProcessImageNameW = kernel32.func(
    'int __stdcall QueryFullProcessImageNameW(HANDLE hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)',
  )
  const OpenProcessToken = advapi32.func('int __stdcall OpenProcessToken(HANDLE ProcessHandle, uint32_t DesiredAccess, _Out_ HANDLE *TokenHandle)')
  const GetTokenInformation = advapi32.func(
    'int __stdcall GetTokenInformation(HANDLE TokenHandle, int TokenInformationClass, _Out_ uint32_t *TokenInformation, uint32_t TokenInformationLength, _Out_ uint32_t *ReturnLength)',
  )
  void HANDLE

  const utf16 = (buffer: Uint16Array, length: number) => Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le')

  cached = {
    inputSize,
    sendInput(inputs) {
      if (!inputs.length) return 0
      return SendInput(inputs.length, inputs, inputSize) as number
    },
    getSystemMetrics(index) {
      return GetSystemMetrics(index) as number
    },
    mapVirtualKey(vk, mapType) {
      return MapVirtualKeyW(vk, mapType) as number
    },
    lockWorkStation() {
      return (LockWorkStation() as number) !== 0
    },
    getForegroundWindow() {
      return GetForegroundWindow()
    },
    windowText(hwnd) {
      if (!hwnd) return ''
      const buffer = new Uint16Array(512)
      const length = GetWindowTextW(hwnd, buffer, buffer.length) as number
      return length > 0 ? utf16(buffer, length) : ''
    },
    windowProcessId(hwnd) {
      if (!hwnd) return 0
      const pid = [0]
      GetWindowThreadProcessId(hwnd, pid)
      return pid[0]
    },
    inputDesktopName() {
      const desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS)
      if (!desktop) return null
      try {
        const buffer = new Uint16Array(256)
        const needed = [0]
        const ok = GetUserObjectInformationW(desktop, UOI_NAME, buffer, buffer.length * 2, needed) as number
        if (!ok) return null
        const length = Math.max(0, Math.min(buffer.length, needed[0] / 2 - 1))
        return utf16(buffer, length).replace(/\0+$/, '')
      } finally {
        CloseDesktop(desktop)
      }
    },
    processImagePath(pid) {
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) return null
      try {
        const buffer = new Uint16Array(1024)
        const size = [buffer.length]
        const ok = QueryFullProcessImageNameW(handle, 0, buffer, size) as number
        return ok ? utf16(buffer, size[0]) : null
      } finally {
        CloseHandle(handle)
      }
    },
    processIsElevated(pid) {
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) return null
      try {
        const token: unknown[] = [null]
        if (!(OpenProcessToken(handle, TOKEN_QUERY, token) as number) || !token[0]) return null
        try {
          const elevation = [0]
          const returned = [0]
          const ok = GetTokenInformation(token[0], TOKEN_ELEVATION, elevation, 4, returned) as number
          return ok ? elevation[0] !== 0 : null
        } finally {
          CloseHandle(token[0])
        }
      } finally {
        CloseHandle(handle)
      }
    },
    setThreadExecutionState(flags) {
      return SetThreadExecutionState(flags) as number
    },
    getDoubleClickTime() {
      return GetDoubleClickTime() as number
    },
  }
  return cached
}
