namespace ShaderIndexer.Models;

public sealed class ShaderDatabase
{
    public int Version { get; set; } = 1;

    public DateTime GeneratedAtUtc { get; set; }

    public UnityDatabaseInfo? Unity { get; set; }

    public UrpDatabaseInfo? Urp { get; set; }

    public List<IncludeInfo> Includes { get; set; }
        = [];

    public List<FunctionInfo> Functions { get; set; }
        = [];

    public List<StructInfo> Structs { get; set; }
        = [];

    public List<MacroInfo> Macros { get; set; }
        = [];

    public List<ShaderVariableInfo> Variables { get; set; }
        = [];

    public List<string> SourceFiles { get; set; }
        = [];
}

public sealed class UnityDatabaseInfo
{
    public string? Version { get; set; }
}

public sealed class UrpDatabaseInfo
{
    public string? Version { get; set; }

    public string? PackagePath { get; set; }
}
