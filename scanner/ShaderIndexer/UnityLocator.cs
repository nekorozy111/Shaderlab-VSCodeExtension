using System.Text.Json;

namespace ShaderIndexer;

public sealed class UnityLocator
{
    public UnityProjectInfo? LocateProject(
        string projectPath)
    {
        var fullProjectPath =
            Path.GetFullPath(projectPath);

        if (!Directory.Exists(fullProjectPath))
        {
            return null;
        }

        var manifestPath =
            Path.Combine(
                fullProjectPath,
                "Packages",
                "manifest.json"
            );

        if (!File.Exists(manifestPath))
        {
            return null;
        }

        var project =
            new UnityProjectInfo
            {
                ProjectPath =
                    fullProjectPath,

                ManifestPath =
                    manifestPath
            };

        project.UnityVersion =
            FindUnityVersion(
                fullProjectPath
            );

        project.Packages =
            FindPackages(
                fullProjectPath
            );

        project.UrpPackage =
            FindUrpPackage(
                project
            );

        return project;
    }

    private string? FindUnityVersion(
        string projectPath)
    {
        /*
         * Unity プロジェクトの
         * ProjectVersion.txt を参照します。
         *
         * ProjectSettings/ProjectVersion.txt
         */
        var versionPath =
            Path.Combine(
                projectPath,
                "ProjectSettings",
                "ProjectVersion.txt"
            );

        if (!File.Exists(versionPath))
        {
            return null;
        }

        foreach (
            var line in File.ReadLines(
                versionPath
            ))
        {
            const string prefix =
                "m_EditorVersion:";

            if (!line.StartsWith(
                    prefix,
                    StringComparison.Ordinal))
            {
                continue;
            }

            return line[
                prefix.Length..]
                .Trim();
        }

        return null;
    }

    private Dictionary<string, string>
        FindPackages(
            string projectPath)
    {
        var result =
            new Dictionary<
                string,
                string>(
                StringComparer.OrdinalIgnoreCase
            );

        var packagesPath =
            Path.Combine(
                projectPath,
                "Packages"
            );

        if (!Directory.Exists(
                packagesPath))
        {
            return result;
        }

        var manifestPath =
            Path.Combine(
                packagesPath,
                "manifest.json"
            );

        if (!File.Exists(
                manifestPath))
        {
            return result;
        }

        try
        {
            using var stream =
                File.OpenRead(
                    manifestPath
                );

            using var document =
                JsonDocument.Parse(
                    stream
                );

            if (!document.RootElement
                    .TryGetProperty(
                        "dependencies",
                        out var dependencies))
            {
                return result;
            }

            foreach (
                var dependency
                in dependencies.EnumerateObject())
            {
                result[
                    dependency.Name] =
                    dependency.Value
                        .GetString()
                    ?? string.Empty;
            }
        }
        catch (
            JsonException)
        {
            /*
             * manifest.json が壊れている場合は
             * 空の結果として扱います。
             */
        }

        return result;
    }

    private UnityPackageInfo?
        FindUrpPackage(
            UnityProjectInfo project)
    {
        const string packageName =
            "com.unity.render-pipelines.universal";

        if (!project.Packages.TryGetValue(
                packageName,
                out var version))
        {
            /*
             * manifest.json に
             * URP が直接書かれていないケースも
             * 後で PackageCache から探索します。
             */
            return FindUrpFromPackageCache(
                project.ProjectPath
            );
        }

        return ResolvePackage(
            project,
            packageName,
            version
        );
    }

    private UnityPackageInfo?
        ResolvePackage(
            UnityProjectInfo project,
            string packageName,
            string version)
    {
        var packageCachePath =
            Path.Combine(
                project.ProjectPath,
                "Library",
                "PackageCache"
            );

        if (!Directory.Exists(
                packageCachePath))
        {
            return null;
        }

        /*
         * PackageCache の実際のディレクトリ名は、
         *
         * com.unity.render-pipelines.universal@17.0.3
         *
         * のようになります。
         */
        var directory =
            Directory.EnumerateDirectories(
                packageCachePath,
                $"{packageName}@*",
                SearchOption.TopDirectoryOnly
            )
            .FirstOrDefault();

        if (directory == null)
        {
            return null;
        }

        return new UnityPackageInfo
        {
            Name =
                packageName,

            Version =
                version,

            RootPath =
                directory
        };
    }

    private UnityPackageInfo?
        FindUrpFromPackageCache(
            string projectPath)
    {
        const string packageName =
            "com.unity.render-pipelines.universal";

        var packageCachePath =
            Path.Combine(
                projectPath,
                "Library",
                "PackageCache"
            );

        if (!Directory.Exists(
                packageCachePath))
        {
            return null;
        }

        var directory =
            Directory.EnumerateDirectories(
                packageCachePath,
                $"{packageName}@*",
                SearchOption.TopDirectoryOnly
            )
            .FirstOrDefault();

        if (directory == null)
        {
            return null;
        }

        var packageJson =
            Path.Combine(
                directory,
                "package.json"
            );

        var version =
            ReadPackageVersion(
                packageJson
            );

        return new UnityPackageInfo
        {
            Name =
                packageName,

            Version =
                version,

            RootPath =
                directory
        };
    }

    private string? ReadPackageVersion(
        string packageJsonPath)
    {
        if (!File.Exists(
                packageJsonPath))
        {
            return null;
        }

        try
        {
            using var stream =
                File.OpenRead(
                    packageJsonPath
                );

            using var document =
                JsonDocument.Parse(
                    stream
                );

            if (document.RootElement
                    .TryGetProperty(
                        "version",
                        out var version))
            {
                return version.GetString();
            }
        }
        catch (
            JsonException)
        {
            // Ignore invalid package.json.
        }

        return null;
    }
}

public sealed class UnityProjectInfo
{
    public string ProjectPath { get; set; }
        = string.Empty;

    public string ManifestPath { get; set; }
        = string.Empty;

    public string? UnityVersion { get; set; }

    public Dictionary<
        string,
        string> Packages { get; set; }
        = new(
            StringComparer.OrdinalIgnoreCase
        );

    public UnityPackageInfo?
        UrpPackage { get; set; }
}

public sealed class UnityPackageInfo
{
    public string Name { get; set; }
        = string.Empty;

    public string? Version { get; set; }

    public string RootPath { get; set; }
        = string.Empty;
}
