namespace ShaderIndexer.Models;

public sealed class IncludeInfo : ShaderSymbol
{
    public string Path { get; set; }
        = string.Empty;

    public string? ResolvedPath { get; set; }

    public string? Package { get; set; }

    public List<string> Aliases { get; set; }
        = [];

    public bool IsUnityInclude { get; set; }

    public bool IsUrpInclude { get; set; }
}
