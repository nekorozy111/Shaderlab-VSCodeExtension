using System.Text.RegularExpressions;
using ShaderIndexer.Models;

namespace ShaderIndexer;

public sealed class HlslParser
{
    private static readonly Regex IncludeRegex =
        new(
            @"^\s*#\s*include\s*[<""]([^>""]+)[>""]",
            RegexOptions.Compiled
        );

    private static readonly Regex DefineRegex =
        new(
            @"^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*(.*)$",
            RegexOptions.Compiled
        );

    private static readonly Regex StructRegex =
        new(
            @"\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{",
            RegexOptions.Compiled
        );

    private static readonly Regex FunctionRegex =
        new(
            @"(?m)^\s*(?:(?:inline|static|extern|precise|const)\s+)*" +
            @"([A-Za-z_][A-Za-z0-9_<>,\[\]\s\*]*)\s+" +
            @"([A-Za-z_][A-Za-z0-9_]*)\s*" +
            @"\(([^;{}]*)\)\s*(?:\{|;)",
            RegexOptions.Compiled
        );

    private static readonly Regex CBufferStartRegex =
        new(
            @"^\s*CBUFFER_START\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)",
            RegexOptions.Compiled
        );

    private static readonly Regex CBufferEndRegex =
        new(
            @"^\s*CBUFFER_END\s*\(\s*\)?",
            RegexOptions.Compiled
        );

    private static readonly Regex TextureRegex =
        new(
            @"^\s*(TEXTURE2D|TEXTURE2D_ARRAY|TEXTURE3D|TEXTURECUBE|TEXTURE2DMS|TEXTURE2DMS_ARRAY)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)",
            RegexOptions.Compiled
        );

    private static readonly Regex SamplerRegex =
        new(
            @"^\s*(SAMPLER|SAMPLER_CMP)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)",
            RegexOptions.Compiled
        );

    private static readonly Regex BufferRegex =
        new(
            @"^\s*(StructuredBuffer|RWStructuredBuffer|AppendStructuredBuffer|ConsumeStructuredBuffer|Buffer|RWBuffer)\s*<\s*([^>]+)\s*>\s+([A-Za-z_][A-Za-z0-9_]*)",
            RegexOptions.Compiled
        );

    private static readonly Regex RawBufferRegex =
        new(
            @"^\s*(ByteAddressBuffer|RWByteAddressBuffer)\s+([A-Za-z_][A-Za-z0-9_]*)",
            RegexOptions.Compiled
        );

    private static readonly Regex VariableRegex =
        new(
            @"^\s*(?:(?:static|const|uniform|precise|volatile|row_major|column_major)\s+)*" +
            @"([A-Za-z_][A-Za-z0-9_<>,\[\]\s\*]*)\s+" +
            @"([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*(?:=[^;]+)?;",
            RegexOptions.Compiled
        );

    private static readonly Regex StructMemberRegex =
        new(
            @"^\s*(?:(?:static|const|precise)\s+)*" +
            @"([A-Za-z_][A-Za-z0-9_<>,\[\]\s\*]*)\s+" +
            @"([A-Za-z_][A-Za-z0-9_]*)" +
            @"(?:\s*\[[^\]]+\])?\s*" +
            @"(?:\:\s*([A-Za-z_][A-Za-z0-9_]*))?\s*;",
            RegexOptions.Compiled
        );

    private static readonly Regex RegisterRegex =
        new(
            @"\bregister\s*\(\s*([A-Za-z0-9_]+)\s*\)",
            RegexOptions.Compiled
        );

    public void ParseFile(
        string file,
        ShaderDatabase database)
    {
        if (!File.Exists(file))
        {
            return;
        }

        var text =
            File.ReadAllText(file);

        ParseText(
            text,
            file,
            database
        );
    }

    public void ParseText(
        string text,
        string file,
        ShaderDatabase database)
    {
        var lines =
            text.Split(
                '\n'
            );

        string? currentCBuffer = null;

        var structRanges =
            new List<(int Start, int End, StructInfo Struct)>();

        for (
            var index = 0;
            index < lines.Length;
            index++)
        {
            var line =
                lines[index];

            var lineNumber =
                index + 1;

            var trimmed =
                line.Trim();

            if (string.IsNullOrWhiteSpace(
                    trimmed))
            {
                continue;
            }

            /*
             * ----------------------------------------
             * #include
             * ----------------------------------------
             */
            var includeMatch =
                IncludeRegex.Match(
                    line
                );

            if (includeMatch.Success)
            {
                var path =
                    includeMatch.Groups[1].Value;

                database.Includes.Add(
                    new IncludeInfo
                    {
                        Name =
                            Path.GetFileName(path),

                        Path =
                            NormalizePath(path),

                        File =
                            file,

                        Line =
                            lineNumber,

                        IsUnityInclude =
                            IsUnityInclude(path),

                        IsUrpInclude =
                            IsUrpInclude(path),

                        Kind =
                            "include"
                    }
                );

                continue;
            }

            /*
             * ----------------------------------------
             * #define
             * ----------------------------------------
             */
            var defineMatch =
                DefineRegex.Match(
                    line
                );

            if (defineMatch.Success)
            {
                ParseMacro(
                    defineMatch,
                    file,
                    lineNumber,
                    database
                );

                continue;
            }

            /*
             * ----------------------------------------
             * CBUFFER_START
             * ----------------------------------------
             */
            var cbufferStart =
                CBufferStartRegex.Match(
                    line
                );

            if (cbufferStart.Success)
            {
                currentCBuffer =
                    cbufferStart.Groups[1].Value;

                continue;
            }

            /*
             * ----------------------------------------
             * CBUFFER_END
             * ----------------------------------------
             */
            if (CBufferEndRegex.IsMatch(
                    line))
            {
                currentCBuffer = null;

                continue;
            }

            /*
             * ----------------------------------------
             * Unity Texture macro
             * ----------------------------------------
             */
            var textureMatch =
                TextureRegex.Match(
                    line
                );

            if (textureMatch.Success)
            {
                ParseTexture(
                    textureMatch,
                    file,
                    lineNumber,
                    database
                );

                continue;
            }

            /*
             * ----------------------------------------
             * Unity Sampler macro
             * ----------------------------------------
             */
            var samplerMatch =
                SamplerRegex.Match(
                    line
                );

            if (samplerMatch.Success)
            {
                ParseSampler(
                    samplerMatch,
                    file,
                    lineNumber,
                    database
                );

                continue;
            }

            /*
             * ----------------------------------------
             * StructuredBuffer etc.
             * ----------------------------------------
             */
            var bufferMatch =
                BufferRegex.Match(
                    line
                );

            if (bufferMatch.Success)
            {
                ParseBuffer(
                    bufferMatch,
                    file,
                    lineNumber,
                    database
                );

                continue;
            }

            /*
             * ----------------------------------------
             * ByteAddressBuffer
             * ----------------------------------------
             */
            var rawBufferMatch =
                RawBufferRegex.Match(
                    line
                );

            if (rawBufferMatch.Success)
            {
                ParseRawBuffer(
                    rawBufferMatch,
                    file,
                    lineNumber,
                    database
                );

                continue;
            }

            /*
             * ----------------------------------------
             * struct
             * ----------------------------------------
             */
            var structMatch =
                StructRegex.Match(
                    line
                );

            if (structMatch.Success)
            {
                var structInfo =
                    ParseStruct(
                        lines,
                        index,
                        structMatch,
                        file,
                        database
                    );

                if (structInfo != null)
                {
                    var end =
                        FindStructEnd(
                            lines,
                            index
                        );

                    structRanges.Add(
                        (
                            index,
                            end,
                            structInfo
                        )
                    );

                    index = end;

                    continue;
                }
            }

            /*
             * ----------------------------------------
             * 通常の変数
             * ----------------------------------------
             */
            var variableMatch =
                VariableRegex.Match(
                    line
                );

            if (variableMatch.Success)
            {
                ParseVariable(
                    variableMatch,
                    file,
                    lineNumber,
                    currentCBuffer,
                    database
                );
            }
        }

        /*
         * Function は複数行宣言を考慮して
         * ファイル全体から解析します。
         */
        ParseFunctions(
            text,
            file,
            database
        );
    }

    private static void ParseMacro(
        Match match,
        string file,
        int line,
        ShaderDatabase database)
    {
        var name =
            match.Groups[1].Value;

        var parameterText =
            match.Groups[2].Value;

        var value =
            match.Groups[3].Value.Trim();

        var parameters =
            string.IsNullOrWhiteSpace(
                parameterText)
                ? []
                : parameterText
                    .Split(',')
                    .Select(
                        x => x.Trim()
                    )
                    .Where(
                        x =>
                            !string.IsNullOrWhiteSpace(
                                x
                            )
                    )
                    .ToList();

        database.Macros.Add(
            new MacroInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    line,

                Parameters =
                    parameters,

                Value =
                    string.IsNullOrWhiteSpace(
                        value)
                        ? null
                        : value,

                Kind =
                    "macro",

                Signature =
                    parameters.Count == 0
                        ? $"#define {name}"
                        : $"#define {name}({string.Join(", ", parameters)})"
            }
        );
    }

    private static void ParseTexture(
        Match match,
        string file,
        int line,
        ShaderDatabase database)
    {
        var macro =
            match.Groups[1].Value;

        var name =
            match.Groups[2].Value;

        database.Variables.Add(
            new ShaderVariableInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    line,

                Kind =
                    "texture",

                Type =
                    macro,

                TextureDimension =
                    GetTextureDimension(
                        macro
                    ),

                IsTexture =
                    true,

                Signature =
                    $"{macro}({name})"
            }
        );
    }

    private static void ParseSampler(
        Match match,
        string file,
        int line,
        ShaderDatabase database)
    {
        var macro =
            match.Groups[1].Value;

        var name =
            match.Groups[2].Value;

        database.Variables.Add(
            new ShaderVariableInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    line,

                Kind =
                    "sampler",

                Type =
                    macro,

                IsSampler =
                    true,

                IsReadOnly =
                    true,

                Signature =
                    $"{macro}({name})"
            }
        );
    }

    private static void ParseBuffer(
        Match match,
        string file,
        int line,
        ShaderDatabase database)
    {
        var bufferType =
            match.Groups[1].Value;

        var elementType =
            match.Groups[2].Value.Trim();

        var name =
            match.Groups[3].Value;

        var isWriteOnly =
            bufferType.StartsWith(
                "RW",
                StringComparison.Ordinal
            );

        database.Variables.Add(
            new ShaderVariableInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    line,

                Kind =
                    "buffer",

                Type =
                    bufferType,

                ElementType =
                    elementType,

                BufferType =
                    bufferType,

                IsBuffer =
                    true,

                IsWriteOnly =
                    isWriteOnly,

                IsReadOnly =
                    !isWriteOnly,

                Signature =
                    $"{bufferType}<{elementType}> {name}"
            }
        );
    }

    private static void ParseRawBuffer(
        Match match,
        string file,
        int line,
        ShaderDatabase database)
    {
        var bufferType =
            match.Groups[1].Value;

        var name =
            match.Groups[2].Value;

        var isWriteOnly =
            bufferType.StartsWith(
                "RW",
                StringComparison.Ordinal
            );

        database.Variables.Add(
            new ShaderVariableInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    line,

                Kind =
                    "buffer",

                Type =
                    bufferType,

                BufferType =
                    bufferType,

                IsBuffer =
                    true,

                IsWriteOnly =
                    isWriteOnly,

                IsReadOnly =
                    !isWriteOnly,

                Signature =
                    $"{bufferType} {name}"
            }
        );
    }

    private static void ParseVariable(
        Match match,
        string file,
        int line,
        string? cbuffer,
        ShaderDatabase database)
    {
        var type =
            NormalizeType(
                match.Groups[1].Value
            );

        var name =
            match.Groups[2].Value;

        /*
         * 型として認識できないものを
         * 変数として登録しない。
         */
        if (!LooksLikeType(type))
        {
            return;
        }

        database.Variables.Add(
            new ShaderVariableInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    line,

                Kind =
                    cbuffer == null
                        ? "variable"
                        : "cbuffer-variable",

                Type =
                    type,

                CBuffer =
                    cbuffer,

                IsReadOnly =
                    type.StartsWith(
                        "const ",
                        StringComparison.Ordinal
                    ),

                Signature =
                    $"{type} {name}"
            }
        );
    }

    private static StructInfo? ParseStruct(
        string[] lines,
        int startLine,
        Match structMatch,
        string file,
        ShaderDatabase database)
    {
        var name =
            structMatch.Groups[1].Value;

        var info =
            new StructInfo
            {
                Name =
                    name,

                File =
                    file,

                Line =
                    startLine + 1,

                Kind =
                    "struct",

                Signature =
                    $"struct {name}"
            };

        var end =
            FindStructEnd(
                lines,
                startLine
            );

        for (
            var i = startLine + 1;
            i <= end && i < lines.Length;
            i++)
        {
            var memberMatch =
                StructMemberRegex.Match(
                    lines[i]
                );

            if (!memberMatch.Success)
            {
                continue;
            }

            var member =
                new StructMemberInfo
                {
                    Name =
                        memberMatch.Groups[2].Value,

                    Type =
                        NormalizeType(
                            memberMatch.Groups[1].Value
                        ),

                    Semantic =
                        string.IsNullOrWhiteSpace(
                            memberMatch.Groups[3].Value)
                            ? null
                            : memberMatch.Groups[3].Value,

                    File =
                        file,

                    Line =
                        i + 1
                };

            info.Members.Add(
                member
            );
        }

        database.Structs.Add(
            info
        );

        return info;
    }

    private static void ParseFunctions(
        string text,
        string file,
        ShaderDatabase database)
    {
        foreach (
            Match match
            in FunctionRegex.Matches(
                text
            ))
        {
            var returnType =
                NormalizeType(
                    match.Groups[1].Value
                );

            var name =
                match.Groups[2].Value;

            if (IsControlKeyword(
                    name))
            {
                continue;
            }

            var parameterText =
                match.Groups[3].Value;

            var parameters =
                ParseParameters(
                    parameterText
                );

            var line =
                GetLineNumber(
                    text,
                    match.Index
                );

            database.Functions.Add(
                new FunctionInfo
                {
                    Name =
                        name,

                    File =
                        file,

                    Line =
                        line,

                    ReturnType =
                        returnType,

                    Parameters =
                        parameters,

                    Kind =
                        "function",

                    Signature =
                        $"{returnType} {name}({string.Join(", ", parameters.Select(p => $"{p.Type} {p.Name}"))})"
                }
            );
        }
    }

    private static List<FunctionParameterInfo>
        ParseParameters(
            string text)
    {
        var result =
            new List<FunctionParameterInfo>();

        if (string.IsNullOrWhiteSpace(
                text))
        {
            return result;
        }

        foreach (
            var rawParameter
            in SplitParameters(text))
        {
            var parameter =
                rawParameter.Trim();

            if (parameter.Length == 0)
            {
                continue;
            }

            parameter =
                Regex.Replace(
                    parameter,
                    @"\b(inout|in|out|uniform|const)\b",
                    "",
                    RegexOptions.IgnoreCase
                ).Trim();

            var parts =
                parameter.Split(
                    ' ',
                    StringSplitOptions.RemoveEmptyEntries
                );

            if (parts.Length == 1)
            {
                result.Add(
                    new FunctionParameterInfo
                    {
                        Name =
                            parts[0],

                        Type =
                            parts[0]
                    }
                );

                continue;
            }

            var name =
                parts[^1];

            var type =
                string.Join(
                    " ",
                    parts[..^1]
                );

            result.Add(
                new FunctionParameterInfo
                {
                    Name =
                        name,

                    Type =
                        type
                }
            );
        }

        return result;
    }

    private static IEnumerable<string>
        SplitParameters(
            string text)
    {
        var depth = 0;

        var start = 0;

        for (
            var i = 0;
            i < text.Length;
            i++)
        {
            switch (text[i])
            {
                case '<':
                    depth++;
                    break;

                case '>':
                    depth--;
                    break;

                case ',' when depth == 0:
                    yield return
                        text[start..i];

                    start =
                        i + 1;

                    break;
            }
        }

        if (start < text.Length)
        {
            yield return
                text[start..];
        }
    }

    private static int FindStructEnd(
        string[] lines,
        int start)
    {
        var depth = 0;

        var started =
            false;

        for (
            var i = start;
            i < lines.Length;
            i++)
        {
            foreach (
                var character
                in lines[i])
            {
                if (character == '{')
                {
                    depth++;
                    started = true;
                }
                else if (character == '}')
                {
                    depth--;

                    if (
                        started &&
                        depth <= 0)
                    {
                        return i;
                    }
                }
            }
        }

        return start;
    }

    private static int GetLineNumber(
        string text,
        int position)
    {
        var line = 1;

        for (
            var i = 0;
            i < position && i < text.Length;
            i++)
        {
            if (text[i] == '\n')
            {
                line++;
            }
        }

        return line;
    }

    private static string
        NormalizeType(
            string type)
    {
        return Regex.Replace(
                type,
                @"\s+",
                " "
            )
            .Trim();
    }

    private static bool LooksLikeType(
        string type)
    {
        if (string.IsNullOrWhiteSpace(
                type))
        {
            return false;
        }

        return
            type.Contains(
                "float",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "half",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "int",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "uint",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "bool",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "real",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "min16",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            type.Contains(
                "struct",
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static bool IsControlKeyword(
        string name)
    {
        return name is
            "if" or
            "for" or
            "while" or
            "switch" or
            "catch";
    }

    private static string
        NormalizePath(
            string path)
    {
        return path
            .Replace(
                '\\',
                '/'
            )
            .Trim();
    }

    private static bool IsUnityInclude(
        string path)
    {
        return
            path.Contains(
                "Packages/com.unity.",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            path.Contains(
                "UnityCG",
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static bool IsUrpInclude(
        string path)
    {
        return
            path.Contains(
                "render-pipelines.universal",
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static string
        GetTextureDimension(
            string macro)
    {
        return macro switch
        {
            "TEXTURE2D" =>
                "2D",

            "TEXTURE2D_ARRAY" =>
                "2DArray",

            "TEXTURE3D" =>
                "3D",

            "TEXTURECUBE" =>
                "Cube",

            "TEXTURE2DMS" =>
                "2DMS",

            "TEXTURE2DMS_ARRAY" =>
                "2DMSArray",

            _ =>
                "Unknown"
        };
    }
}
