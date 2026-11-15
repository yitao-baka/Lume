using MicaSetup;
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace MicaSetup.Helper;

/// <summary>
/// Preserves Lume's optional SYSTEM service and elevation-agent task across an
/// upgrade, and removes only the registrations owned by this install directory
/// during uninstall. A portable copy can own the same service/task names, so a
/// name-only check would steal its registration.
/// </summary>
internal static class LumeCompanion
{
    private const string ServiceName = "LumeSVC";
    private const string AgentTaskName = @"Lume\LumeAgent";
    private static bool serviceWasInstalled;
    private static bool agentTaskWasInstalled;

    public static void PrepareForInstall()
    {
        serviceWasInstalled = OwnsService();
        agentTaskWasInstalled = OwnsAgentTask();

        Exception? firstError = null;
        if (serviceWasInstalled)
        {
            firstError = TryRun("lume-svc.exe", "--uninstall");
        }
        if (agentTaskWasInstalled)
        {
            firstError ??= TryRun("lume-agent.exe", "--uninstall-task");
        }
        if (firstError != null)
        {
            throw new InvalidOperationException("Unable to stop the existing Lume service or agent task before upgrading.", firstError);
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

    public static void RemoveOwnedInstall()
    {
        Exception? firstError = null;
        if (OwnsService())
        {
            firstError = TryRun("lume-svc.exe", "--uninstall");
        }
        if (OwnsAgentTask())
        {
            firstError ??= TryRun("lume-agent.exe", "--uninstall-task");
        }
        if (firstError != null)
        {
            Logger.Error(firstError);
        }
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
