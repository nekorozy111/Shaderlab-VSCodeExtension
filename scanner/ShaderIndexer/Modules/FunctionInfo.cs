namespace ShaderIndexer.Models;

public sealed class FunctionInfo : ShaderSymbol
{
    public string ReturnType { get; set; }
        = string.Empty;

    public List<FunctionParameterInfo> Parameters { get; set; }
        = [];
}

public sealed class FunctionParameterInfo
{
    public string Name { get; set; }
        = string.Empty;

    public string Type { get; set; }
        = string.Empty;
}
