using ShaderIndexer.Models;

namespace ShaderIndexer;

public sealed class ShaderScanner
{
    private static readonly string[]
        SupportedExtensions =
        [
            ".shader",
            ".hlsl",
            ".cginc",
            ".compute"
        ];

    public IReadOnlyList<string>
        ScanUnityProject(
            UnityProjectInfo project)
    {
        var files =
            new HashSet<string>(
                StringComparer.OrdinalIgnoreCase
            );

        /*
         * URP package
         */
        if (project.UrpPackage != null)
        {
            ScanDirectory(
                project.UrpPackage.RootPath,
                files
            );
        }

        /*
         * Core RP package
         *
         * URP の HLSL が依存している
         * com.unity.render-pipelines.core も
         * 後で重要になります。
         */
        ScanCorePackage(
            project,
            files
        );

        /*
         * Packages 配下にある
         * Unity Package の shader source も探索します。
         *
         * これは将来的に
         * ShaderGraph 等へ拡張する際にも利用できます。
         */
        ScanPackagesDirectory(
            project.ProjectPath,
            files
        );

        return files
            .OrderBy(
                path => path,
                StringComparer.OrdinalIgnoreCase
            )
            .ToArray();
    }

    public IReadOnlyList<string>
        ScanDirectory(
            string directory)
    {
        var files =
            new HashSet<string>(
                StringComparer.OrdinalIgnoreCase
            );

        ScanDirectory(
            directory,
            files
        );

        return files
            .OrderBy(
                path => path,
                StringComparer.OrdinalIgnoreCase
            )
            .ToArray();
    }

    private void ScanDirectory(
        string directory,
        HashSet<string> files)
    {
        if (!Directory.Exists(
                directory))
        {
            return;
        }

        IEnumerable<string> entries;

        try
        {
            entries =
                Directory.EnumerateFiles(
                    directory,
                    "*.*",
                    SearchOption.AllDirectories
                );
        }
        catch (
            UnauthorizedAccessException)
        {
            return;
        }
        catch (
            IOException)
        {
            return;
        }

        foreach (var file in entries)
        {
            if (!IsSupportedFile(
                    file))
            {
                continue;
            }

            /*
             * Git や node_modules 等の
             * 不要な巨大ディレクトリを
             * 今後除外しやすくするため、
             * ここでフィルタリングします。
             */
            if (ShouldIgnore(
                    file))
            {
                continue;
            }

            files.Add(
                Path.GetFullPath(file)
            );
        }
    }

    private void ScanCorePackage(
        UnityProjectInfo project,
        HashSet<string> files)
    {
        const string packageName =
            "com.unity.render-pipelines.core";

        var packageCache =
            Path.Combine(
                project.ProjectPath,
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
                $"{packageName}@*",
                SearchOption.TopDirectoryOnly
            )
            .FirstOrDefault();

        if (directory == null)
        {
            return;
        }

        ScanDirectory(
            directory,
            files
        );
    }

    private void ScanPackagesDirectory(
        string projectPath,
        HashSet<string> files)
    {
        var packages =
            Path.Combine(
                projectPath,
                "Packages"
            );

        if (!Directory.Exists(
                packages))
        {
            return;
        }

        /*
         * プロジェクトの Packages に
         * ローカル package が存在する場合を考慮。
         */
        foreach (
            var directory
            in Directory.EnumerateDirectories(
                packages,
                "*",
                SearchOption.TopDirectoryOnly))
        {
            /*
             * manifest.json などのファイルではなく
             * directory のみ。
             */
            ScanDirectory(
                directory,
                files
            );
        }
    }

    private static bool IsSupportedFile(
        string file)
    {
        var extension =
            Path.GetExtension(file);

        return SupportedExtensions
            .Contains(
                extension,
                StringComparer.OrdinalIgnoreCase
            );
    }

    private static bool ShouldIgnore(
        string file)
    {
        var normalized =
            file.Replace(
                '\\',
                '/'
            );

        /*
         * Unity PackageCache 内では通常
         * 以下は問題ありませんが、
         * ローカル package を走査する際に
         * 不要な巨大ディレクトリを除外します。
         */
        string[] ignored =
        [
            "/node_modules/",
            "/.git/",
            "/Temp/",
            "/Library/ShaderCache/"
        ];

        return ignored.Any(
            value =>
                normalized.Contains(
                    value,
                    StringComparison.OrdinalIgnoreCase
                )
        );
    }
}
