using MicaSetup;
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace MicaSetup.Helper;

/// <summary>
/// Preserves Lume's optional SYSTEM service and elevation-agent task across an
/// upgrade, and removes only the processes and registrations owned by this
/// install directory during uninstall. A portable copy can use the same binary
/// and service/task names, so name-only checks would steal its resources.
/// </summary>
internal static class LumeCompanion
{
    private const string ServiceName = "LumeSVC";
    private const string AgentTaskName = @"Lume\LumeAgent";
    private static bool serviceWasInstalled;
    private static bool agentTaskWasInstalled;

    public static void PrepareForInstall()
    {
        Exception? firstError = TerminateOwnedProcesses("lume.exe", "lume-agent.exe");
        serviceWasInstalled = OwnsService();
        agentTaskWasInstalled = OwnsAgentTask();

        if (serviceWasInstalled)
        {
            firstError ??= UninstallOwnedService();
        }
        else
        {
            firstError ??= TerminateOwnedProcesses("lume-svc.exe");
        }
        if (agentTaskWasInstalled)
        {
            firstError ??= TryRun("lume-agent.exe", "--uninstall-task");
        }
        if (firstError != null)
        {
            throw new InvalidOperationException("Unable to stop running Lume processes, the service, or the agent task before upgrading.", firstError);
        }
    }

    public static void RestoreAfterInstall()
    {
        Exception? firstError = null;
        if (serviceWasInstalled)
        {
            firstError = TryRun("lume-svc.exe", "--install");
        }
        if (agentTaskWasInstalled)
        {
            firstError ??= TryRun("lume-agent.exe", "--install-task");
        }
        serviceWasInstalled = false;
        agentTaskWasInstalled = false;
        if (firstError != null)
        {
            throw new InvalidOperationException("Lume was installed, but restoring its service or agent task failed.", firstError);
        }
    }

    public static Exception? RemoveOwnedInstall()
    {
        Exception? firstError = TerminateOwnedProcesses("lume.exe", "lume-agent.exe");
        if (OwnsService())
        {
            firstError ??= UninstallOwnedService();
        }
        else
        {
            firstError ??= TerminateOwnedProcesses("lume-svc.exe");
        }
        if (OwnsAgentTask())
        {
            firstError ??= TryRun("lume-agent.exe", "--uninstall-task");
        }
        if (firstError != null)
        {
            Logger.Error(firstError);
        }
        return firstError;
    }

    /// <summary>
    /// True when the uninstaller was started with /purge or --purge.
    /// The option is opt-in: ordinary uninstall keeps personal data.
    /// </summary>
    public static bool PurgeRequested()
    {
        return CommandLineHelper.Has("purge");
    }

    /// <summary>
    /// True when an executable owned by this installation is still running.
    /// The installer uses this to ask the user before force-closing anything.
    /// </summary>
    public static bool HasOwnedRunningProcesses()
    {
        return HasOwnedProcess("lume.exe")
            || HasOwnedProcess("lume-agent.exe")
            || HasOwnedProcess("lume-svc.exe");
    }

    private static bool HasOwnedProcess(string exeName)
    {
        string expected = Path.GetFullPath(Path.Combine(Option.Current.InstallLocation, exeName));
        string processName = Path.GetFileNameWithoutExtension(exeName);
        foreach (Process process in Process.GetProcessesByName(processName))
        {
            try
            {
                if (process.HasExited)
                {
                    continue;
                }
                string? actual = process.MainModule?.FileName;
                if (string.IsNullOrWhiteSpace(actual))
                {
                    // Cannot prove it belongs elsewhere; asking is safer than
                    // silently killing it.
                    return true;
                }
                if (string.Equals(Path.GetFullPath(actual), expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            catch (Exception e)
            {
                Logger.Error(e);
                return true;
            }
            finally
            {
                process.Dispose();
            }
        }
        return false;
    }

    /// <summary>
    /// Stop the installed launcher and agent before MicaSetup's file-writable
    /// check runs. The full service/task teardown remains in
    /// RemoveOwnedInstall(); this early step only removes the executable lock
    /// that otherwise blocks the uninstall wizard.
    /// </summary>
    public static Exception? StopOwnedLauncherProcesses()
    {
        return TerminateOwnedProcesses("lume.exe", "lume-agent.exe");
    }

    /// <summary>
    /// Run the Rust-owned cleanup policy before MicaSetup removes the install
    /// directory. The helper removes fixed current-user data roots, WebView2
    /// state, plugin credentials, autostart, Lume-authored temp files, and the
    /// service DataDir key. Locked files are scheduled for reboot by the helper.
    /// </summary>
    public static void PurgeAllData(Exception? companionError)
    {
        string details = companionError == null
            ? string.Empty
            : $"Service/task cleanup: {companionError}";

        try
        {
            string exe = Path.Combine(Option.Current.InstallLocation, "lume-svc.exe");
            if (!File.Exists(exe))
            {
                throw new FileNotFoundException("lume-svc.exe was not found in the installation directory.", exe);
            }

            ProcessResult result = RunProcess(exe, "--purge-user-data", 300000);
            string processDetails = FormatProcessDetails(result);
            if (!string.IsNullOrWhiteSpace(processDetails))
            {
                details = JoinDetails(details, processDetails);
            }

            if (result.ExitCode == 2 && companionError == null)
            {
                ShowInfo("LumePurgeRebootTips".Tr());
                return;
            }
            if (result.ExitCode != 0 || companionError != null)
            {
                ShowPurgeFailure(details);
            }
        }
        catch (Exception e)
        {
            Logger.Error(e);
            ShowPurgeFailure(JoinDetails(details, e.ToString()));
        }
    }

    private static void ShowPurgeFailure(string details)
    {
        string message = "LumePurgeFailedTips".Tr();
        if (!string.IsNullOrWhiteSpace(details))
        {
            message = $"{message}\n\n{details}";
        }
        ShowInfo(message);
    }

    private static void ShowInfo(string message)
    {
        ApplicationDispatcherHelper.Invoke(main =>
            MicaSetup.Design.Controls.MessageBox.Info(main, message));
    }

    private static string FormatProcessDetails(ProcessResult result)
    {
        string details = result.Error.Trim();
        if (!string.IsNullOrWhiteSpace(result.Output))
        {
            details = JoinDetails(details, result.Output.Trim());
        }
        return details;
    }

    private static string JoinDetails(string first, string second)
    {
        if (string.IsNullOrWhiteSpace(first))
        {
            return second;
        }
        if (string.IsNullOrWhiteSpace(second))
        {
            return first;
        }
        return $"{first}\n{second}";
    }

    private static Exception? UninstallOwnedService()
    {
        Exception? error = TryRun("lume-svc.exe", "--uninstall");
        if (error != null)
        {
            Exception? killError = TerminateOwnedProcesses("lume-svc.exe");
            Exception? retryError = TryRun("lume-svc.exe", "--uninstall");
            return retryError ?? killError ?? error;
        }
        return TerminateOwnedProcesses("lume-svc.exe");
    }

    /// <summary>
    /// Terminate only processes whose executable path is exactly inside this
    /// installation. A name-only kill would take down an unrelated portable
    /// Lume copy that happens to use the same binary names.
    /// </summary>
    private static Exception? TerminateOwnedProcesses(params string[] exeNames)
    {
        Exception? firstError = null;
        foreach (string exeName in exeNames)
        {
            string expected = Path.GetFullPath(Path.Combine(Option.Current.InstallLocation, exeName));
            string processName = Path.GetFileNameWithoutExtension(exeName);
            foreach (Process process in Process.GetProcessesByName(processName))
            {
                try
                {
                    if (process.HasExited)
                    {
                        continue;
                    }
                    string? actual = process.MainModule?.FileName;
                    if (string.IsNullOrWhiteSpace(actual))
                    {
                        throw new InvalidOperationException($"Could not verify the executable path for {processName} (PID={process.Id}).");
                    }
                    actual = Path.GetFullPath(actual);
                    if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    Logger.Information($"[LumeCompanion] Terminating {exeName} (PID={process.Id})");
                    process.Kill();
                    if (!process.WaitForExit(5000))
                    {
                        throw new TimeoutException($"{exeName} (PID={process.Id}) did not exit after termination.");
                    }
                }
                catch (Exception e)
                {
                    Logger.Error(e);
                    firstError ??= e;
                }
                finally
                {
                    process.Dispose();
                }
            }
        }
        return firstError;
    }

    private static bool OwnsService()
    {
        try
        {
            ProcessResult exists = RunProcess(Path.Combine(Environment.SystemDirectory, "sc.exe"), $"query \"{ServiceName}\"", 10000);
            if (exists.ExitCode != 0)
            {
                return false;
            }

            ProcessResult config = RunProcess(Path.Combine(Environment.SystemDirectory, "sc.exe"), $"qc \"{ServiceName}\"", 10000);
            return config.ExitCode == 0 && ContainsExpectedPath(config.Output, "lume-svc.exe");
        }
        catch (Exception e)
        {
            Logger.Error(e);
            return false;
        }
    }

    private static bool OwnsAgentTask()
    {
        try
        {
            ProcessResult result = RunProcess(
                Path.Combine(Environment.SystemDirectory, "schtasks.exe"),
                $"/Query /TN \"{AgentTaskName}\" /FO LIST /V",
                10000);
            return result.ExitCode == 0 && ContainsExpectedPath(result.Output, "lume-agent.exe");
        }
        catch (Exception e)
        {
            Logger.Error(e);
            return false;
        }
    }

    private static bool ContainsExpectedPath(string output, string exeName)
    {
        string expected = Path.GetFullPath(Path.Combine(Option.Current.InstallLocation, exeName));
        return output.IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static Exception? TryRun(string exeName, string arguments)
    {
        try
        {
            string exe = Path.Combine(Option.Current.InstallLocation, exeName);
            if (!File.Exists(exe))
            {
                throw new FileNotFoundException($"{exeName} was not found in the installation directory.", exe);
            }

            ProcessResult result = RunProcess(exe, arguments, 120000);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"{exeName} {arguments} exited with code {result.ExitCode}. {result.Error}".Trim());
            }
            return null;
        }
        catch (Exception e)
        {
            Logger.Error(e);
            return e;
        }
    }

    private static ProcessResult RunProcess(string fileName, string arguments, int timeoutMs)
    {
        ProcessStartInfo startInfo = new(fileName, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Could not start {fileName}.");
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(); } catch { }
            throw new TimeoutException($"{Path.GetFileName(fileName)} {arguments} timed out.");
        }
        Task.WaitAll(output, error);
        return new ProcessResult(process.ExitCode, output.Result, error.Result);
    }

    private sealed record ProcessResult(int ExitCode, string Output, string Error);
}
