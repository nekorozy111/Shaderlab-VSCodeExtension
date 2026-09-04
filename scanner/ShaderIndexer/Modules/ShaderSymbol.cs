namespace ShaderIndexer.Models;

public class ShaderSymbol
{
    public string Name { get; set; }
        = string.Empty;

    public string? File { get; set; }

    public int? Line { get; set; }

    public string? Documentation { get; set; }

    public string? Kind { get; set; }

    public string? Signature { get; set; }
}
