using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

// An explicitly installed AGY launcher for a same-user Windows service. Nothing
// is copied from Credential Manager. The child uses a credential-bearing user
// token, while CreateProcessWithTokenW keeps it in the caller's service session.
internal static class Program
{
    private const uint NoWindow = 0x08000000, Suspended = 4, KillOnJobClose = 0x2000;

    public static int Main(string[] argv)
    {
        try
        {
            string executable = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "agy-path.txt")).Trim();
            if (!Path.IsPathFullyQualified(executable) || !File.Exists(executable))
                throw new InvalidOperationException("AGY_EXECUTABLE_UNAVAILABLE");
            using var current = WindowsIdentity.GetCurrent();
            foreach (var donor in Process.GetProcessesByName("explorer"))
            {
                using (donor)
                {
                    IntPtr token = OpenSameUserToken(donor, current.User);
                    if (token == IntPtr.Zero) continue;
                    try { return Launch(token, executable, argv); }
                    finally { CloseHandle(token); }
                }
            }
            throw new InvalidOperationException("AGY_AUTH_CONTEXT_UNAVAILABLE: no credential-bearing login for the service user");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static IntPtr OpenSameUserToken(Process donor, SecurityIdentifier? user)
    {
        IntPtr process = IntPtr.Zero, token = IntPtr.Zero;
        try
        {
            if (donor.SessionId == 0 || user is null) return IntPtr.Zero;
            process = OpenProcess(0x1000, false, (uint)donor.Id);
            if (process == IntPtr.Zero || !OpenProcessToken(process, 0xA, out token)) return IntPtr.Zero;
            using var identity = new WindowsIdentity(token);
            if (identity.User != user) return IntPtr.Zero;
            if (!DuplicateTokenEx(token, 0x02000000, IntPtr.Zero, 2, 1, out var primary))
                throw NativeError("AGY_DUPLICATE_TOKEN_FAILED");
            return primary;
        }
        catch (InvalidOperationException) { return IntPtr.Zero; } // Donor exited during enumeration.
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            if (process != IntPtr.Zero) CloseHandle(process);
        }
    }

    // Quote one argument using the Windows CommandLineToArgvW convention;
    // preserve empty strings, Unicode, embedded quotes and trailing backslashes.
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static int Launch(IntPtr token, string executable, string[] argv)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw NativeError("AGY_CREATE_JOB_FAILED");
        var process = new ProcessInformation();
        bool assigned = false;
        try
        {
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = KillOnJobClose } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
                throw NativeError("AGY_CONFIGURE_JOB_FAILED");
            var startup = new StartupInfo
            {
                Size = Marshal.SizeOf<StartupInfo>(), Flags = 0x101, ShowWindow = 0,
                Input = GetStdHandle(-10), Output = GetStdHandle(-11), Error = GetStdHandle(-12),
            };
            var command = new StringBuilder(Quote(executable) + " " + string.Join(" ", argv.Select(Quote)));
            if (!CreateProcessWithTokenW(token, 0, executable, command, NoWindow | Suspended,
                    IntPtr.Zero, Environment.CurrentDirectory, ref startup, out process))
                throw NativeError("AGY_CREATE_PROCESS_FAILED");
            // Never let the child run until its lifetime is tied to this launcher.
            // Remote cancellation/timeout/Host shutdown closes the job and all children.
            if (!AssignProcessToJobObject(job, process.Process))
                throw NativeError("AGY_ASSIGN_JOB_FAILED");
            assigned = true;
            if (ResumeThread(process.Thread) == uint.MaxValue) throw NativeError("AGY_RESUME_FAILED");
            if (WaitForSingleObject(process.Process, uint.MaxValue) != 0)
                throw NativeError("AGY_WAIT_FAILED");
            if (!GetExitCodeProcess(process.Process, out uint code)) throw NativeError("AGY_EXIT_CODE_FAILED");
            return unchecked((int)code);
        }
        finally
        {
            if (!assigned && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
        }
    }

    private static Exception NativeError(string stage) => new Win32Exception(Marshal.GetLastWin32Error(), stage);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size; public string? Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr primary);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessWithTokenW(IntPtr token, uint logon, string app, StringBuilder command, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int id);
}
