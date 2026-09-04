using System.Text.Json;
using System.Text.Json.Serialization;
using ShaderIndexer.Models;

namespace ShaderIndexer;

public static class Program
{
    public static int Main(
        string[] args)
    {
        Console.WriteLine(
            "Unity Shader IntelliSense Indexer"
        );

        Console.WriteLine(
            "----------------------------------"
        );

        var options =
            ParseArguments(args);

        if (options == null)
        {
            PrintUsage();

            return 1;
        }

        var locator =
            new UnityLocator();

        var project =
            locator.LocateProject(
                options.ProjectPath
            );

        if (project == null)
        {
            Console.Error.WriteLine(
                "The specified directory is not a valid Unity project."
            );

            return 2;
        }

        Console.WriteLine();

        Console.WriteLine(
            $"Project : {project.ProjectPath}"
        );

        Console.WriteLine(
            $"Unity   : {project.UnityVersion ?? "Unknown"}"
        );

        if (project.UrpPackage == null)
        {
            Console.Error.WriteLine();

            Console.Error.WriteLine(
                "URP package was not found."
            );

            return 3;
        }

        Console.WriteLine(
            $"URP     : {project.UrpPackage.Version ?? "Unknown"}"
        );

        Console.WriteLine(
            $"URP Path: {project.UrpPackage.RootPath}"
        );

        /*
         * 1. Source files
         */
        var scanner =
            new ShaderScanner();

        var files =
            scanner.ScanUnityProject(
                project
            );

        Console.WriteLine();

        Console.WriteLine(
            $"Shader source files: {files.Count}"
        );

        /*
         * 2. Parse
         */
        var parser =
            new HlslParser();

        var database =
            new ShaderDatabase
            {
                Version = 1,

                GeneratedAtUtc =
                    DateTime.UtcNow,

                Unity =
                    new UnityDatabaseInfo
                    {
                        Version =
                            project.UnityVersion
                    },

                Urp =
                    new UrpDatabaseInfo
                    {
                        Version =
                            project.UrpPackage.Version,

                        PackagePath =
                            project.UrpPackage.RootPath
                    },

                SourceFiles =
                    files
                        .Select(
                            file =>
                                MakeRelativePath(
                                    project.ProjectPath,
                                    file
                                )
                        )
                        .ToList()
            };

        var parsedFiles = 0;

        foreach (var file in files)
        {
            try
            {
                parser.ParseFile(
                    file,
                    database
                );

                parsedFiles++;
            }
            catch (Exception exception)
            {
                /*
                 * 1ファイルの問題で
                 * 全体のIndex生成を停止しない。
                 */
                Console.Error.WriteLine(
                    $"Failed to parse: {file}"
                );

                Console.Error.WriteLine(
                    $"  {exception.Message}"
                );
            }
        }

        Console.WriteLine();

        Console.WriteLine(
            $"Parsed files : {parsedFiles}"
        );

        Console.WriteLine(
            $"Includes     : {database.Includes.Count}"
        );

        Console.WriteLine(
            $"Functions    : {database.Functions.Count}"
        );

        Console.WriteLine(
            $"Structs      : {database.Structs.Count}"
        );

        Console.WriteLine(
            $"Macros       : {database.Macros.Count}"
        );

        Console.WriteLine(
            $"Variables    : {database.Variables.Count}"
        );

        /*
         * 3. Normalize
         */
        NormalizeDatabase(
            database
        );
        var includeResolver =
    new IncludeResolver(
        project
    );

        includeResolver.ResolveDatabase(
            database
        );


        /*
         * 4. JSON
         */
        var outputPath =
            options.OutputPath
            ?? Path.Combine(
                project.ProjectPath,
                "Library",
                "ShaderIntelliSense",
                "shader-intellisense.json"
            );

        var outputDirectory =
            Path.GetDirectoryName(
                Path.GetFullPath(
                    outputPath
                )
            );

        if (!string.IsNullOrWhiteSpace(
                outputDirectory))
        {
            Directory.CreateDirectory(
                outputDirectory
            );
        }

        WriteDatabase(
            database,
            outputPath
        );

        Console.WriteLine();

        Console.WriteLine(
            $"Database:"
        );

        Console.WriteLine(
            $"  {Path.GetFullPath(outputPath)}"
        );

        Console.WriteLine();

        return 0;
    }

    private static IndexerOptions?
        ParseArguments(
            string[] args)
    {
        if (args.Length == 0)
        {
            return null;
        }

        string? projectPath = null;
        string? outputPath = null;

        for (
            var i = 0;
            i < args.Length;
            i++)
        {
            var argument =
                args[i];

            if (string.Equals(
                    argument,
                    "--project",
                    StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 >= args.Length)
                {
                    return null;
                }

                projectPath =
                    args[++i];

                continue;
            }

            if (string.Equals(
                    argument,
                    "--output",
                    StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 >= args.Length)
                {
                    return null;
                }

                outputPath =
                    args[++i];

                continue;
            }

            /*
             * 旧形式:
             *
             * ShaderIndexer <projectPath>
             */
            if (
                projectPath == null &&
                !argument.StartsWith("-"))
            {
                projectPath =
                    argument;

                continue;
            }

            return null;
        }

        if (string.IsNullOrWhiteSpace(
                projectPath))
        {
            return null;
        }

        return new IndexerOptions
        {
            ProjectPath =
                Path.GetFullPath(
                    projectPath
                ),

            OutputPath =
                string.IsNullOrWhiteSpace(
                    outputPath)
                    ? null
                    : Path.GetFullPath(
                        outputPath
                    )
        };
    }

    private static void PrintUsage()
    {
        Console.WriteLine();

        Console.WriteLine(
            "Usage:"
        );

        Console.WriteLine();

        Console.WriteLine(
            "  ShaderIndexer --project <path>"
        );

        Console.WriteLine(
            "  ShaderIndexer --project <path> --output <path>"
        );

        Console.WriteLine();

        Console.WriteLine(
            "Example:"
        );

        Console.WriteLine();

        Console.WriteLine(
            "  ShaderIndexer --project \"D:/Projects/MyGame\""
        );
    }

    private static void NormalizeDatabase(
        ShaderDatabase database)
    {
        database.Includes =
            database.Includes
                .GroupBy(
                    include =>
                        include.Path,
                    StringComparer.OrdinalIgnoreCase
                )
                .Select(
                    group =>
                    {
                        var first =
                            group
                                .OrderByDescending(
                                    include =>
                                        include.ResolvedPath != null
                                )
                                .ThenBy(
                                    include =>
                                        include.File,
                                    StringComparer.OrdinalIgnoreCase
                                )
                                .First();

                        first.Aliases =
                            group
                                .SelectMany(
                                    include =>
                                        include.Aliases
                                )
                                .Distinct(
                                    StringComparer.OrdinalIgnoreCase
                                )
                                .OrderBy(
                                    alias =>
                                        alias,
                                    StringComparer.OrdinalIgnoreCase
                                )
                                .ToList();

                        return first;
                    }
                )
                .OrderBy(
                    include =>
                        include.Path,
                    StringComparer.OrdinalIgnoreCase
                )
                .ToList();


        database.Structs =
            database.Structs
                .GroupBy(
                    structure =>
                        structure.Name,
                    StringComparer.Ordinal
                )
                .Select(
                    group =>
                        group
                            .OrderBy(
                                structure =>
                                    structure.File,
                                StringComparer.OrdinalIgnoreCase
                            )
                            .First()
                )
                .OrderBy(
                    structure =>
                        structure.Name,
                    StringComparer.Ordinal
                )
                .ToList();

        database.Functions =
            database.Functions
                .GroupBy(
                    function =>
                        CreateFunctionKey(
                            function
                        ),
                    StringComparer.Ordinal
                )
                .Select(
                    group =>
                        group.First()
                )
                .OrderBy(
                    function =>
                        function.Name,
                    StringComparer.Ordinal
                )
                .ToList();

        database.Macros =
            database.Macros
                .GroupBy(
                    macro =>
                        macro.Name,
                    StringComparer.Ordinal
                )
                .Select(
                    group =>
                        group
                            .OrderBy(
                                macro =>
                                    macro.File,
                                StringComparer.OrdinalIgnoreCase
                            )
                            .First()
                )
                .OrderBy(
                    macro =>
                        macro.Name,
                    StringComparer.Ordinal
                )
                .ToList();

        database.Variables =
            database.Variables
                .GroupBy(
                    variable =>
                        variable.Name,
                    StringComparer.Ordinal
                )
                .Select(
                    group =>
                        group
                            .OrderBy(
                                variable =>
                                    variable.File,
                                StringComparer.OrdinalIgnoreCase
                            )
                            .First()
                )
                .OrderBy(
                    variable =>
                        variable.Name,
                    StringComparer.Ordinal
                )
                .ToList();

        database.SourceFiles =
            database.SourceFiles
                .Distinct(
                    StringComparer.OrdinalIgnoreCase
                )
                .OrderBy(
                    file => file,
                    StringComparer.OrdinalIgnoreCase
                )
                .ToList();
    }

    private static string
        CreateFunctionKey(
            FunctionInfo function)
    {
        var builder =
            new System.Text.StringBuilder();

        builder.Append(
            function.Name
        );

        builder.Append('|');

        builder.Append(
            function.ReturnType
        );

        foreach (
            var parameter
            in function.Parameters)
        {
            builder.Append('|');

            builder.Append(
                parameter.Type
            );

            builder.Append('|');

            builder.Append(
                parameter.Name
            );
        }

        return builder.ToString();
    }

    private static void WriteDatabase(
        ShaderDatabase database,
        string outputPath)
    {
        var jsonOptions =
            new JsonSerializerOptions
            {
                WriteIndented = true,

                DefaultIgnoreCondition =
                    JsonIgnoreCondition.WhenWritingNull
            };

        var json =
            JsonSerializer.Serialize(
                database,
                jsonOptions
            );

        /*
         * 一時ファイルに書いてから
         * Move することで、
         * VS Code が生成途中の JSON を
         * 読む可能性を下げます。
         */
        var fullPath =
            Path.GetFullPath(
                outputPath
            );

        var tempPath =
            fullPath + ".tmp";

        File.WriteAllText(
            tempPath,
            json
        );

        File.Move(
            tempPath,
            fullPath,
            true
        );
    }

    private static string
        MakeRelativePath(
            string basePath,
            string filePath)
    {
        var baseUri =
            new Uri(
                EnsureTrailingSeparator(
                    Path.GetFullPath(
                        basePath
                    )
                )
            );

        var fileUri =
            new Uri(
                Path.GetFullPath(
                    filePath
                )
            );

        return Uri.UnescapeDataString(
            baseUri
                .MakeRelativeUri(
                    fileUri
                )
                .ToString()
        )
        .Replace(
            '/',
            Path.DirectorySeparatorChar
        );
    }

    private static string
        EnsureTrailingSeparator(
            string path)
    {
        if (
            path.EndsWith(
                Path.DirectorySeparatorChar
                    .ToString(),
                StringComparison.Ordinal))
        {
            return path;
        }

        return path +
            Path.DirectorySeparatorChar;
    }

    private sealed class IndexerOptions
    {
        public string ProjectPath { get; set; }
            = string.Empty;

        public string? OutputPath { get; set; }
    }
}
