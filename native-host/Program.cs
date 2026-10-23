using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int MaxBrowserMessage = 65536;
    private const int MaxDesktopMessage = 192 * 1024 * 1024;
    private static readonly SemaphoreSlim OutputLock = new(1, 1);
    private static readonly Stream Input = Console.OpenStandardInput();
    private static readonly Stream Output = Console.OpenStandardOutput();

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length < 1) throw new InvalidOperationException("Missing extension origin.");
            var origin = args[0].TrimEnd('/');
            var configPath = Path.Combine(AppContext.BaseDirectory, "native-config.json");
            using var config = JsonDocument.Parse(await File.ReadAllTextAsync(configPath));
            var allowed = config.RootElement.GetProperty("origins").EnumerateArray().Select(o => o.GetString()).ToArray();
            if (!allowed.Contains(origin)) throw new InvalidOperationException("Extension is not authorized.");
            var dataDirectory = Environment.GetEnvironmentVariable("SNAPFLOW_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "snapflow");
            var authPath = Path.Combine(dataDirectory, "native-bridge.json");
            var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "SnapFlow.exe"));
            
            // Only a fixed, installed desktop executable can be launched. Browser messages cannot launch programs.
            if (!File.Exists(authPath)) StartDesktop(executable);
            using var connectTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            JsonDocument? auth = null;
            while (!connectTimeout.IsCancellationRequested)
            {
                try { auth = JsonDocument.Parse(await File.ReadAllTextAsync(authPath, connectTimeout.Token)); break; }
                catch (IOException) { await Task.Delay(200, connectTimeout.Token); }
            }
            auth?.Dispose();
            using var socket = await ConnectDesktop(origin, executable, connectTimeout.Token);
            using (var currentAuth = JsonDocument.Parse(await File.ReadAllTextAsync(authPath, connectTimeout.Token)))
            {
                var token = currentAuth.RootElement.GetProperty("token").GetString()!;
                if (token.Length != 64 || token.Any(c => !Uri.IsHexDigit(c))) throw new InvalidOperationException("Invalid desktop authentication.");
                await socket.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = "native-auth", token })), WebSocketMessageType.Text, true, connectTimeout.Token);
            }
            using var stop = new CancellationTokenSource();
            var input = BrowserToDesktop(socket, stop.Token);
            var output = DesktopToBrowser(socket, stop.Token);
            var completed = await Task.WhenAny(input, output);
            stop.Cancel();
            try { await completed; } catch (OperationCanceledException) { }
            try { await Task.WhenAll(input, output); } catch (OperationCanceledException) { }
            return 0;
        }
        catch (Exception e)
        {
            // stdout belongs exclusively to the native-messaging protocol, including errors.
            try { await WriteFrame(new { type = "error", error = e is InvalidOperationException ? e.Message : "The native connection was interrupted. Start SnapFlow and reconnect." }, CancellationToken.None); } catch { }
            return 1;
        }
    }
    private static async Task<ClientWebSocket> ConnectDesktop(string origin, string executable, CancellationToken cancel)
    {
        var launched = false;
        while (!cancel.IsCancellationRequested)
        {
            var socket = new ClientWebSocket(); socket.Options.SetRequestHeader("Origin", origin);
            try { await socket.ConnectAsync(new Uri("ws://127.0.0.1:47831/bridge"), cancel); return socket; }
            catch (WebSocketException)
            {
                socket.Dispose();
                if (!launched) { StartDesktop(executable); launched = true; }
                await Task.Delay(300, cancel);
            }
        }
        throw new InvalidOperationException("The desktop app did not start. Open SnapFlow, then reconnect.");
    }
    private static void StartDesktop(string executable)
    {
        if (OperatingSystem.IsWindows() && File.Exists(executable)) Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
    }
    private static async Task BrowserToDesktop(ClientWebSocket socket, CancellationToken cancel)
    {
        var header = new byte[4];
        while (!cancel.IsCancellationRequested)
        {
            var count = await Input.ReadAsync(header.AsMemory(0, 4), cancel);
            if (count == 0) return;
            await Input.ReadExactlyAsync(header.AsMemory(count, 4 - count), cancel);
            var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (length == 0 || length > MaxBrowserMessage) throw new InvalidOperationException("Invalid native message size.");
            var buffer = new byte[(int)length];
            await Input.ReadExactlyAsync(buffer, cancel);
            using var message = JsonDocument.Parse(buffer);
            var type = message.RootElement.GetProperty("type").GetString();
            if (type is not ("tabs" or "result" or "progress" or "ping")) throw new InvalidOperationException("Unsupported browser message.");
            await socket.SendAsync(buffer, WebSocketMessageType.Text, true, cancel);
        }
    }
    private static async Task DesktopToBrowser(ClientWebSocket socket, CancellationToken cancel)
    {
        var buffer = new byte[65536];
        while (!cancel.IsCancellationRequested)
        {
            using var message = new MemoryStream();
            WebSocketReceiveResult received;
            do
            {
                received = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancel);
                if (received.MessageType == WebSocketMessageType.Close) return;
                if (received.MessageType != WebSocketMessageType.Text || message.Length + received.Count > MaxDesktopMessage) throw new InvalidOperationException("Invalid desktop transfer.");
                await message.WriteAsync(buffer.AsMemory(0, received.Count), cancel);
            } while (!received.EndOfMessage);
            var text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            if (text.Length < 65536)
            {
                using var value = JsonDocument.Parse(text); await WriteFrame(value.RootElement, cancel);
            }
            else
            {
                var transferId = Guid.NewGuid().ToString();
                var total = (text.Length + 65535) / 65536;
                for (var i = 0; i < total; i++) await WriteFrame(new { type = "chunk", transferId, index = i, total, data = text.Substring(i * 65536, Math.Min(65536, text.Length - i * 65536)) }, cancel);
            }
        }
    }
    private static async Task WriteFrame<T>(T message, CancellationToken cancel)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(message);
        if (data.Length > 1024 * 1024) throw new InvalidOperationException("Native message exceeded browser limit.");
        var header = new byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)data.Length);
        await OutputLock.WaitAsync(cancel);
        try { await Output.WriteAsync(header, cancel); await Output.WriteAsync(data, cancel); await Output.FlushAsync(cancel); }
        finally { OutputLock.Release(); }
    }
}
