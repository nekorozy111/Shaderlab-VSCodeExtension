using ShaderIndexer.Models;

namespace ShaderIndexer;

public sealed class IncludeResolver
{
    private readonly UnityProjectInfo _project;

    private readonly List<string> _searchDirectories = [];

    private readonly Dictionary<
        string,
        string> _fileIndex =
        new(
            StringComparer.OrdinalIgnoreCase
        );

    public IncludeResolver(
        UnityProjectInfo project)
    {
        _project = project;

        BuildSearchDirectories();

        BuildFileIndex();
    }

    public void ResolveDatabase(
        ShaderDatabase database)
    {
        foreach (
            var include
            in database.Includes)
        {
            ResolveInclude(
                include
            );
        }
    }

    public string? Resolve(
        string includePath,
        string? sourceFile = null)
    {
        if (string.IsNullOrWhiteSpace(
                includePath))
        {
            return null;
        }

        /*
         * 1. include をそのまま解決
         */
        var direct =
            ResolveDirectPath(
                includePath
            );

        if (direct != null)
        {
            return direct;
        }

        /*
         * 2. include 元ファイルからの相対パス
         */
        if (!string.IsNullOrWhiteSpace(
                sourceFile))
        {
            var sourceDirectory =
                Path.GetDirectoryName(
                    sourceFile
                );

            if (!string.IsNullOrWhiteSpace(
                    sourceDirectory))
            {
                var relative =
                    Path.Combine(
                        sourceDirectory,
                        includePath
                    );

                if (File.Exists(
                        relative))
                {
                    return Path.GetFullPath(
                        relative
                    );
                }
            }
        }

        /*
         * 3. 登録済み HLSL index から検索
         */
        var normalized =
            NormalizeIncludePath(
                includePath
            );

        if (_fileIndex.TryGetValue(
                normalized,
                out var indexed))
        {
            return indexed;
        }

        /*
         * ファイル名だけの場合。
         *
         * 例:
         *
         * #include "Core.hlsl"
         */
        var fileName =
            Path.GetFileName(
                includePath
            );

        if (_fileIndex.TryGetValue(
                fileName,
                out indexed))
        {
            return indexed;
        }

        return null;
    }

    private void ResolveInclude(
        IncludeInfo include)
    {
        var resolved =
            Resolve(
                include.Path,
                include.File
            );

        if (resolved == null)
        {
            return;
        }

        include.ResolvedPath =
            resolved;

        include.Package =
            DetectPackage(
                resolved
            );

        include.IsUnityInclude =
            include.IsUnityInclude ||
            IsUnityPath(
                resolved
            );

        include.IsUrpInclude =
            include.IsUrpInclude ||
            IsUrpPath(
                resolved
            );

        AddAliases(
            include,
            resolved
        );
    }

    private void BuildSearchDirectories()
    {
        /*
         * Unity Project の Packages
         */
        AddSearchDirectory(
            Path.Combine(
                _project.ProjectPath,
                "Packages"
            )
        );

        /*
         * Library/PackageCache
         */
        AddSearchDirectory(
            Path.Combine(
                _project.ProjectPath,
                "Library",
                "PackageCache"
            )
        );

        /*
         * URP
         */
        if (_project.UrpPackage != null)
        {
            AddSearchDirectory(
                _project.UrpPackage.RootPath
            );
        }

        /*
         * Core RP
         */
        AddCorePackage();

        /*
         * Assets
         *
         * プロジェクト固有 HLSL の include を
         * 解決できるようにします。
         */
        AddSearchDirectory(
            Path.Combine(
                _project.ProjectPath,
                "Assets"
            )
        );
    }

    private void AddCorePackage()
    {
        var packageCache =
            Path.Combine(
                _project.ProjectPath,
                "Library",
                "PackageCache"
            );

        if (!Directory.Exists(
                packageCache))
        {
            return;
        }

        var directory =
            Directory.EnumerateDirectories(
                packageCache,
                "com.unity.render-pipelines.core@*",
                SearchOption.TopDirectoryOnly
            )
            .FirstOrDefault();

        if (directory != null)
        {
            AddSearchDirectory(
                directory
            );
        }
    }

    private void AddSearchDirectory(
        string directory)
    {
        if (!Directory.Exists(
                directory))
        {
            return;
        }

        var fullPath =
            Path.GetFullPath(
                directory
            );

        if (
            _searchDirectories.Contains(
                fullPath,
                StringComparer.OrdinalIgnoreCase))
        {
            return;
        }

        _searchDirectories.Add(
            fullPath
        );
    }

    private void BuildFileIndex()
    {
        foreach (
            var directory
            in _searchDirectories)
        {
            IEnumerable<string> files;

            try
            {
                files =
                    Directory.EnumerateFiles(
                        directory,
                        "*.*",
                        SearchOption.AllDirectories
                    );
            }
            catch (
                IOException)
            {
                continue;
            }
            catch (
                UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var file in files)
            {
                if (!IsShaderFile(
                        file))
                {
                    continue;
                }

                AddFileToIndex(
                    file
                );
            }
        }
    }

    private void AddFileToIndex(
        string file)
    {
        var fullPath =
            Path.GetFullPath(
                file
            );

        var normalized =
            NormalizeIncludePath(
                fullPath
            );

        if (!_fileIndex.ContainsKey(
                normalized))
        {
            _fileIndex[normalized] =
                fullPath;
        }

        var fileName =
            Path.GetFileName(
                fullPath
            );

        /*
         * 同名ファイルが複数存在する場合は、
         * 最初のものを保持します。
         *
         * URP/Core のような package 内ファイルは
         * 完全パス側の検索を優先します。
         */
        if (!_fileIndex.ContainsKey(
                fileName))
        {
            _fileIndex[fileName] =
                fullPath;
        }

        AddPackageRelativePath(
            fullPath
        );
    }

    private void AddPackageRelativePath(
        string file)
    {
        var packageCache =
            Path.Combine(
                _project.ProjectPath,
                "Library",
                "PackageCache"
            );

        if (!IsPathInside(
                file,
                packageCache))
        {
            return;
        }

        var relative =
            Path.GetRelativePath(
                packageCache,
                file
            );

        var normalized =
            NormalizeIncludePath(
                relative
            );

        _fileIndex[normalized] =
            file;

        /*
         * Packages/xxx/... の形でも登録。
         */
        var parts =
            relative.Split(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );

        if (parts.Length < 2)
        {
            return;
        }

        var packageName =
            parts[0];

        var atIndex =
            packageName.IndexOf(
                '@'
            );

        if (atIndex >= 0)
        {
            packageName =
                packageName[..atIndex];
        }

        var packageRelative =
            string.Join(
                "/",
                parts
            );

        _fileIndex[
            NormalizeIncludePath(
                packageRelative
            )] =
            file;

        var packagePath =
            $"Packages/{packageName}/" +
            string.Join(
                "/",
                parts.Skip(1)
            );

        _fileIndex[
            NormalizeIncludePath(
                packagePath
            )] =
            file;
    }

    private string? ResolveDirectPath(
        string includePath)
    {
        var normalized =
            NormalizeIncludePath(
                includePath
            );

        if (_fileIndex.TryGetValue(
                normalized,
                out var result))
        {
            return result;
        }

        /*
         * Windows/Unix の区切り文字差を吸収。
         */
        var platformPath =
            includePath.Replace(
                '/',
                Path.DirectorySeparatorChar
            );

        foreach (
            var directory
            in _searchDirectories)
        {
            var candidate =
                Path.Combine(
                    directory,
                    platformPath
                );

            if (File.Exists(
                    candidate))
            {
                return Path.GetFullPath(
                    candidate
                );
            }
        }

        return null;
    }

    private string? DetectPackage(
        string file)
    {
        var packageCache =
            Path.Combine(
                _project.ProjectPath,
                "Library",
                "PackageCache"
            );

        if (!IsPathInside(
                file,
                packageCache))
        {
            return null;
        }

        var relative =
            Path.GetRelativePath(
                packageCache,
                file
            );

        var separatorIndex =
            relative.IndexOf(
                Path.DirectorySeparatorChar
            );

        if (separatorIndex < 0)
        {
            return null;
        }

        var packageDirectory =
            relative[..separatorIndex];

        var atIndex =
            packageDirectory.IndexOf(
                '@'
            );

        if (atIndex >= 0)
        {
            packageDirectory =
                packageDirectory[..atIndex];
        }

        return packageDirectory;
    }

    private static void AddAliases(
        IncludeInfo include,
        string resolvedPath)
    {
        var fileName =
            Path.GetFileName(
                resolvedPath
            );

        AddAlias(
            include,
            fileName
        );

        var directory =
            Path.GetDirectoryName(
                resolvedPath
            );

        if (directory == null)
        {
            return;
        }

        var parent =
            new DirectoryInfo(
                directory
            );

        /*
         * ShaderLibrary/Core.hlsl
         */
        AddAlias(
            include,
            $"{parent.Name}/{fileName}"
        );
    }

    private static void AddAlias(
        IncludeInfo include,
        string alias)
    {
        if (string.IsNullOrWhiteSpace(
                alias))
        {
            return;
        }

        if (
            include.Aliases.Contains(
                alias,
                StringComparer.OrdinalIgnoreCase))
        {
            return;
        }

        include.Aliases.Add(
            alias
        );
    }

    private static bool
        IsShaderFile(
            string file)
    {
        var extension =
            Path.GetExtension(
                file
            );

        return
            extension.Equals(
                ".hlsl",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            extension.Equals(
                ".shader",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            extension.Equals(
                ".cginc",
                StringComparison.OrdinalIgnoreCase
            )
            ||
            extension.Equals(
                ".compute",
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static bool
        IsUnityPath(
            string path)
    {
        return
            path.Contains(
                "com.unity.",
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static bool
        IsUrpPath(
            string path)
    {
        return
            path.Contains(
                "render-pipelines.universal",
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static string?
        NormalizeIncludePath(
            string path)
    {
        if (string.IsNullOrWhiteSpace(
                path))
        {
            return null;
        }

        var value =
            path.Trim()
                .Replace(
                    '\\',
                    '/'
                );

        while (
            value.Contains(
                "//",
                StringComparison.Ordinal))
        {
            value =
                value.Replace(
                    "//",
                    "/",
                    StringComparison.Ordinal
                );
        }

        return value;
    }

    private static bool
        IsPathInside(
            string file,
            string directory)
    {
        var fullFile =
            Path.GetFullPath(
                file
            );

        var fullDirectory =
            Path.GetFullPath(
                directory
            );

        if (!fullDirectory.EndsWith(
                Path.DirectorySeparatorChar
                    .ToString(),
                StringComparison.Ordinal))
        {
            fullDirectory +=
                Path.DirectorySeparatorChar;
        }

        return fullFile.StartsWith(
            fullDirectory,
            StringComparison.OrdinalIgnoreCase
        );
    }
}
