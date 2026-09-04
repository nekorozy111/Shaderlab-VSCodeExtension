namespace ShaderIndexer.Models;

public sealed class ShaderVariableInfo : ShaderSymbol
{
    public string Type { get; set; }
        = string.Empty;

    public string? ElementType { get; set; }

    public string? Register { get; set; }

    public string? BufferType { get; set; }

    public string? TextureDimension { get; set; }

    public string? CBuffer { get; set; }

    public bool IsReadOnly { get; set; }

    public bool IsWriteOnly { get; set; }

    public bool IsTexture { get; set; }

    public bool IsSampler { get; set; }

    public bool IsBuffer { get; set; }
}
