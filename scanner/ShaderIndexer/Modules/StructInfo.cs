namespace ShaderIndexer.Models;

public sealed class StructInfo : ShaderSymbol
{
    public List<StructMemberInfo> Members { get; set; }
        = [];
}

public sealed class StructMemberInfo
{
    public string Name { get; set; }
        = string.Empty;

    public string Type { get; set; }
        = string.Empty;

    public string? Semantic { get; set; }

    public string? File { get; set; }

    public int? Line { get; set; }
}
