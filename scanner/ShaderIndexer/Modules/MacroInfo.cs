namespace ShaderIndexer.Models;

public sealed class MacroInfo : ShaderSymbol
{
    public List<string> Parameters { get; set; }
        = [];

    public string? Value { get; set; }
}
