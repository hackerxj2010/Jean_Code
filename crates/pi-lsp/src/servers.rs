//! The language server registry.
//!
//! Every server here is described by what it handles, how to find the
//! project it belongs to, how to start it, and how to install it when it is
//! missing. Sixty-odd servers cover the mainstream of every ecosystem; a
//! server that is not here is one entry of user config away — the registry
//! is data, and user entries are merged into it by id.
//!
//! Two roles. A *primary* server is the one that answers go-to-definition and
//! hover: one per file. A *linter* runs alongside it on the same file and
//! contributes diagnostics — ESLint next to the TypeScript server, Ruff next
//! to Pyright — because the agent should see every problem the project's own
//! tooling would flag, not only the type checker's.

use crate::json::{literal, merge, Json, JsonExt};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Primary,
    Linter,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::Primary => "primary",
            Role::Linter => "linter",
        }
    }
}

/// A release asset for one platform. `os` is `windows`, `linux`, `macos`, or
/// `any`; `arch` is `x86_64`, `aarch64`, or `any`. `pattern` may use `*`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub os: &'static str,
    pub arch: &'static str,
    pub pattern: String,
}

/// How to get a server that is not installed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Install {
    Npm { packages: Vec<String>, bin: String },
    Go { module: String, bin: String },
    Pip { packages: Vec<String>, bin: String },
    Cargo { krate: String, bin: String },
    Gem { gem: String, bin: String },
    Dotnet { tool: String, bin: String },
    Github { repo: String, assets: Vec<Asset>, bin: String },
    Rustup { component: String, bin: String },
    /// Not installable automatically; the hint says how.
    Manual { hint: String },
}

impl Install {
    /// One line for a status listing.
    pub fn describe(&self) -> String {
        match self {
            Install::Npm { packages, .. } => format!("npm install {}", packages.join(" ")),
            Install::Go { module, .. } => format!("go install {module}"),
            Install::Pip { packages, .. } => format!("pip install {}", packages.join(" ")),
            Install::Cargo { krate, .. } => format!("cargo install {krate}"),
            Install::Gem { gem, .. } => format!("gem install {gem}"),
            Install::Dotnet { tool, .. } => format!("dotnet tool install {tool}"),
            Install::Github { repo, .. } => format!("download from github.com/{repo}/releases"),
            Install::Rustup { component, .. } => format!("rustup component add {component}"),
            Install::Manual { hint } => hint.clone(),
        }
    }

    /// The command that must already exist for this recipe to run.
    pub fn needs(&self) -> &'static [&'static str] {
        match self {
            Install::Npm { .. } => &["npm"],
            Install::Go { .. } => &["go"],
            Install::Pip { .. } => &["python"],
            Install::Cargo { .. } => &["cargo"],
            Install::Gem { .. } => &["gem"],
            Install::Dotnet { .. } => &["dotnet"],
            Install::Github { .. } => &["curl"],
            Install::Rustup { .. } => &["rustup"],
            Install::Manual { .. } => &[],
        }
    }

    pub fn automatic(&self) -> bool {
        !matches!(self, Install::Manual { .. })
    }
}

#[derive(Clone, Debug)]
pub struct ServerSpec {
    pub id: String,
    pub name: String,
    /// Extensions without the dot, lower-case.
    pub extensions: Vec<String>,
    /// Whole file names, lower-case: `dockerfile`, `cmakelists.txt`.
    pub filenames: Vec<String>,
    pub command: Vec<String>,
    /// Files marking a project root, searched upward from the file. `*.csproj`
    /// matches by suffix.
    pub root_markers: Vec<String>,
    /// Without a marker, skip rather than fall back to the project root: a
    /// Deno server started on a Node project fights the TypeScript one.
    pub root_required: bool,
    pub role: Role,
    /// Higher wins among servers of the same role.
    pub priority: i32,
    pub initialization: Json,
    pub settings: Json,
    pub env: Vec<(String, String)>,
    pub install: Option<Install>,
    /// The `languageId` to send, when it is not the one the extension implies.
    pub language_id: Option<String>,
    pub disabled: bool,
}

impl ServerSpec {
    fn new(id: &str, name: &str, command: &[&str], extensions: &[&str]) -> Self {
        ServerSpec {
            id: id.to_string(),
            name: name.to_string(),
            extensions: extensions.iter().map(|e| e.to_string()).collect(),
            filenames: Vec::new(),
            command: command.iter().map(|c| c.to_string()).collect(),
            root_markers: vec![".git".to_string()],
            root_required: false,
            role: Role::Primary,
            priority: 0,
            initialization: Json::Null,
            settings: Json::Null,
            env: Vec::new(),
            install: None,
            language_id: None,
            disabled: false,
        }
    }

    fn roots(mut self, markers: &[&str]) -> Self {
        self.root_markers = markers.iter().map(|m| m.to_string()).collect();
        self
    }

    fn required(mut self) -> Self {
        self.root_required = true;
        self
    }

    fn linter(mut self) -> Self {
        self.role = Role::Linter;
        self.root_required = true;
        self
    }

    fn priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    fn init(mut self, text: &str) -> Self {
        self.initialization = literal(text);
        self
    }

    fn settings(mut self, text: &str) -> Self {
        self.settings = literal(text);
        self
    }

    fn files(mut self, names: &[&str]) -> Self {
        self.filenames = names.iter().map(|n| n.to_lowercase()).collect();
        self
    }

    fn npm(mut self, packages: &[&str], bin: &str) -> Self {
        self.install = Some(Install::Npm { packages: packages.iter().map(|p| p.to_string()).collect(), bin: bin.into() });
        self
    }

    fn go(mut self, module: &str, bin: &str) -> Self {
        self.install = Some(Install::Go { module: module.into(), bin: bin.into() });
        self
    }

    fn pip(mut self, packages: &[&str], bin: &str) -> Self {
        self.install = Some(Install::Pip { packages: packages.iter().map(|p| p.to_string()).collect(), bin: bin.into() });
        self
    }

    fn cargo(mut self, krate: &str, bin: &str) -> Self {
        self.install = Some(Install::Cargo { krate: krate.into(), bin: bin.into() });
        self
    }

    fn gem(mut self, gem: &str, bin: &str) -> Self {
        self.install = Some(Install::Gem { gem: gem.into(), bin: bin.into() });
        self
    }

    fn dotnet(mut self, tool: &str, bin: &str) -> Self {
        self.install = Some(Install::Dotnet { tool: tool.into(), bin: bin.into() });
        self
    }

    fn github(mut self, repo: &str, assets: &[(&'static str, &'static str, &str)], bin: &str) -> Self {
        self.install = Some(Install::Github {
            repo: repo.into(),
            assets: assets.iter().map(|(os, arch, pattern)| Asset { os, arch, pattern: pattern.to_string() }).collect(),
            bin: bin.into(),
        });
        self
    }

    fn manual(mut self, hint: &str) -> Self {
        self.install = Some(Install::Manual { hint: hint.into() });
        self
    }

    fn language(mut self, language: &str) -> Self {
        self.language_id = Some(language.into());
        self
    }

    /// Whether this server handles a file, by extension or by name.
    pub fn handles(&self, path: &Path) -> bool {
        let name = crate::languages::file_name(path);
        if self.filenames.iter().any(|known| *known == name) {
            return true;
        }
        let extension = crate::languages::extension_of(path);
        !extension.is_empty() && self.extensions.iter().any(|known| *known == extension)
    }

    /// Layers a user's config entry over this one: fields given replace, and
    /// `initialization` and `settings` merge deeply.
    pub fn with_config(mut self, config: &Json) -> Self {
        let list = |key: &str| {
            config.at(key).map(|value| {
                value.items().iter().filter_map(Json::as_str).map(|s| s.trim_start_matches('.').to_lowercase()).collect::<Vec<_>>()
            })
        };
        if let Some(command) = config.at("command") {
            // `["srv", "--stdio"]`, or `"srv"` with `args` beside it — the
            // shape the `jean.json` config uses.
            let parts: Vec<String> = match command {
                Json::String(single) => vec![single.clone()],
                list => list.items().iter().filter_map(Json::as_str).map(String::from).collect(),
            };
            if !parts.is_empty() {
                self.command = parts;
            }
            // The config shape in `jean.json` keeps arguments separately.
            if let Some(args) = config.at("args") {
                self.command.extend(args.items().iter().filter_map(Json::as_str).map(String::from));
            }
        }
        if let Some(extensions) = list("extensions") {
            self.extensions = extensions;
        }
        if let Some(files) = list("filenames") {
            self.filenames = files;
        }
        if let Some(markers) = config.at("rootMarkers") {
            self.root_markers = markers.items().iter().filter_map(Json::as_str).map(String::from).collect();
        }
        if let Some(Json::Object(env)) = config.at("env") {
            for (key, value) in env {
                if let Some(value) = value.as_str() {
                    self.env.retain(|(existing, _)| existing != key);
                    self.env.push((key.clone(), value.to_string()));
                }
            }
        }
        if let Some(initialization) = config.at("initialization") {
            self.initialization = merge(&self.initialization, initialization);
        }
        if let Some(settings) = config.at("settings") {
            self.settings = merge(&self.settings, settings);
        }
        if let Some(priority) = config.i64_at("priority") {
            self.priority = priority as i32;
        }
        match config.str_at("role") {
            Some("linter") => self.role = Role::Linter,
            Some("primary") => self.role = Role::Primary,
            _ => {}
        }
        if let Some(language) = config.str_at("languageId") {
            self.language_id = Some(language.to_string());
        }
        if let Some(required) = config.bool_at("rootRequired") {
            self.root_required = required;
        }
        if let Some(disabled) = config.bool_at("disabled") {
            self.disabled = disabled;
        }
        self
    }

    /// A server entirely from user config — one this registry does not know.
    pub fn from_config(id: &str, config: &Json) -> Option<Self> {
        let base = ServerSpec::new(id, id, &[], &[]);
        let spec = base.with_config(config);
        (!spec.command.is_empty()).then_some(spec)
    }
}

const TSDK: &str = r#"{"typescript":{"tsdk":"${tsdk}"}}"#;

/// Every bundled server.
pub fn builtin_servers() -> Vec<ServerSpec> {
    let js = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
    vec![
        // ---- JavaScript and TypeScript
        ServerSpec::new("typescript", "TypeScript", &["typescript-language-server", "--stdio"], &js)
            .roots(&["tsconfig.json", "jsconfig.json", "package.json"])
            .priority(10)
            .init(r#"{"preferences":{"includeCompletionsForModuleExports":true,"importModuleSpecifierPreference":"shortest"},"tsserver":{"logVerbosity":"off"}}"#)
            .npm(&["typescript-language-server", "typescript"], "typescript-language-server"),
        ServerSpec::new("vtsls", "vtsls", &["vtsls", "--stdio"], &js)
            .roots(&["tsconfig.json", "jsconfig.json", "package.json"])
            .priority(5)
            .npm(&["@vtsls/language-server", "typescript"], "vtsls"),
        ServerSpec::new("deno", "Deno", &["deno", "lsp"], &["ts", "tsx", "js", "jsx", "mjs"])
            .roots(&["deno.json", "deno.jsonc"])
            .required()
            .priority(20)
            .init(r#"{"enable":true,"lint":true,"unstable":false}"#)
            .manual("install Deno: https://deno.com"),
        ServerSpec::new("eslint", "ESLint", &["vscode-eslint-language-server", "--stdio"], &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro"])
            .roots(&["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"])
            .linter()
            .settings(r#"{"validate":"on","packageManager":"npm","useESLintClass":false,"experimental":{"useFlatConfig":false},"codeActionOnSave":{"enable":false,"mode":"all"},"format":false,"quiet":false,"onIgnoredFiles":"off","rulesCustomizations":[],"run":"onType","problems":{"shortenToSingleLine":false},"nodePath":"","workingDirectory":{"mode":"location"},"codeAction":{"disableRuleComment":{"enable":true,"location":"separateLine"},"showDocumentation":{"enable":true}}}"#)
            .npm(&["vscode-langservers-extracted"], "vscode-eslint-language-server"),
        ServerSpec::new("biome", "Biome", &["biome", "lsp-proxy"], &["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css", "graphql"])
            .roots(&["biome.json", "biome.jsonc"])
            .linter()
            .npm(&["@biomejs/biome"], "biome"),
        ServerSpec::new("oxlint", "Oxlint", &["oxc_language_server"], &["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro"])
            .roots(&[".oxlintrc.json", "oxlintrc.json"])
            .linter()
            .npm(&["oxlint"], "oxc_language_server"),
        ServerSpec::new("vue", "Vue", &["vue-language-server", "--stdio"], &["vue"])
            .roots(&["package.json", "vite.config.ts", "vite.config.js", "nuxt.config.ts"])
            .init(TSDK)
            .npm(&["@vue/language-server", "typescript"], "vue-language-server"),
        ServerSpec::new("svelte", "Svelte", &["svelteserver", "--stdio"], &["svelte"])
            .roots(&["svelte.config.js", "svelte.config.mjs", "package.json"])
            .npm(&["svelte-language-server", "typescript"], "svelteserver"),
        ServerSpec::new("astro", "Astro", &["astro-ls", "--stdio"], &["astro"])
            .roots(&["astro.config.mjs", "astro.config.ts", "astro.config.js", "package.json"])
            .init(TSDK)
            .npm(&["@astrojs/language-server", "typescript"], "astro-ls"),
        ServerSpec::new("tailwindcss", "Tailwind CSS", &["tailwindcss-language-server", "--stdio"], &["html", "css", "scss", "tsx", "jsx", "vue", "svelte", "astro"])
            .roots(&["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs", "tailwind.config.mjs"])
            .linter()
            .npm(&["@tailwindcss/language-server"], "tailwindcss-language-server"),
        ServerSpec::new("graphql", "GraphQL", &["graphql-lsp", "server", "-m", "stream"], &["graphql", "gql"])
            .roots(&[".graphqlrc", ".graphqlrc.yml", ".graphqlrc.json", "graphql.config.js", "graphql.config.ts"])
            .npm(&["graphql-language-service-cli"], "graphql-lsp"),
        ServerSpec::new("prisma", "Prisma", &["prisma-language-server", "--stdio"], &["prisma"])
            .npm(&["@prisma/language-server"], "prisma-language-server"),
        // ---- Web formats
        ServerSpec::new("css", "CSS", &["vscode-css-language-server", "--stdio"], &["css", "scss", "less"])
            .init(r#"{"provideFormatter":true}"#)
            .settings(r#"{"css":{"validate":true},"scss":{"validate":true},"less":{"validate":true}}"#)
            .npm(&["vscode-langservers-extracted"], "vscode-css-language-server"),
        ServerSpec::new("html", "HTML", &["vscode-html-language-server", "--stdio"], &["html", "htm"])
            .init(r#"{"provideFormatter":true,"embeddedLanguages":{"css":true,"javascript":true}}"#)
            .npm(&["vscode-langservers-extracted"], "vscode-html-language-server"),
        ServerSpec::new("json", "JSON", &["vscode-json-language-server", "--stdio"], &["json", "jsonc", "json5"])
            .init(r#"{"provideFormatter":true}"#)
            .settings(r#"{"json":{"validate":{"enable":true},"schemaDownload":{"enable":true}}}"#)
            .npm(&["vscode-langservers-extracted"], "vscode-json-language-server"),
        ServerSpec::new("yaml", "YAML", &["yaml-language-server", "--stdio"], &["yaml", "yml"])
            .settings(r#"{"yaml":{"validate":true,"hover":true,"completion":true,"schemaStore":{"enable":true,"url":"https://www.schemastore.org/api/json/catalog.json"}},"redhat":{"telemetry":{"enabled":false}}}"#)
            .npm(&["yaml-language-server"], "yaml-language-server"),
        ServerSpec::new("taplo", "Taplo (TOML)", &["taplo", "lsp", "stdio"], &["toml"])
            .npm(&["@taplo/cli"], "taplo"),
        ServerSpec::new("markdown", "Marksman", &["marksman", "server"], &["md", "markdown"])
            .roots(&[".marksman.toml", ".git"])
            .github("artempyanykh/marksman", &[("windows", "any", "marksman.exe"), ("linux", "x86_64", "marksman-linux-x64"), ("linux", "aarch64", "marksman-linux-arm64"), ("macos", "any", "marksman-macos")], "marksman"),
        ServerSpec::new("dockerfile", "Dockerfile", &["docker-langserver", "--stdio"], &["dockerfile"])
            .files(&["dockerfile", "containerfile"])
            .npm(&["dockerfile-language-server-nodejs"], "docker-langserver"),
        ServerSpec::new("docker-compose", "Docker Compose", &["docker-compose-langserver", "--stdio"], &[])
            .files(&["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"])
            .linter()
            .roots(&["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"])
            .language("dockercompose")
            .npm(&["@microsoft/compose-language-service"], "docker-compose-langserver"),
        ServerSpec::new("bash", "Bash", &["bash-language-server", "start"], &["sh", "bash", "zsh", "ksh"])
            .files(&[".bashrc", ".zshrc", ".profile"])
            .npm(&["bash-language-server"], "bash-language-server"),
        ServerSpec::new("vim", "Vim script", &["vim-language-server", "--stdio"], &["vim"])
            .files(&[".vimrc"])
            .npm(&["vim-language-server"], "vim-language-server"),
        ServerSpec::new("sql", "SQL (sqls)", &["sqls"], &["sql"])
            .go("github.com/sqls-server/sqls@latest", "sqls"),
        // ---- Systems
        ServerSpec::new("rust-analyzer", "rust-analyzer", &["rust-analyzer"], &["rs"])
            .roots(&["Cargo.toml", "rust-project.json"])
            .settings(r#"{"rust-analyzer":{"check":{"command":"clippy"},"cargo":{"allFeatures":false},"procMacro":{"enable":true}}}"#)
            .github("rust-lang/rust-analyzer", &[
                ("windows", "x86_64", "rust-analyzer-x86_64-pc-windows-msvc.zip"),
                ("windows", "aarch64", "rust-analyzer-aarch64-pc-windows-msvc.zip"),
                ("linux", "x86_64", "rust-analyzer-x86_64-unknown-linux-gnu.gz"),
                ("linux", "aarch64", "rust-analyzer-aarch64-unknown-linux-gnu.gz"),
                ("macos", "x86_64", "rust-analyzer-x86_64-apple-darwin.gz"),
                ("macos", "aarch64", "rust-analyzer-aarch64-apple-darwin.gz"),
            ], "rust-analyzer"),
        ServerSpec::new("clangd", "clangd", &["clangd", "--background-index", "--clang-tidy", "--header-insertion=never"], &["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm", "cu", "ixx"])
            .roots(&["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "meson.build", "Makefile", ".git"])
            .github("clangd/clangd", &[("windows", "any", "clangd-windows-*.zip"), ("linux", "x86_64", "clangd-linux-*.zip"), ("macos", "any", "clangd-mac-*.zip")], "clangd"),
        ServerSpec::new("gopls", "gopls", &["gopls"], &["go"])
            .files(&["go.mod", "go.work", "go.sum"])
            .roots(&["go.work", "go.mod"])
            .settings(r#"{"gopls":{"staticcheck":true,"semanticTokens":true,"usePlaceholders":false}}"#)
            .go("golang.org/x/tools/gopls@latest", "gopls"),
        ServerSpec::new("zls", "zls", &["zls"], &["zig", "zon"])
            .roots(&["build.zig", "build.zig.zon"])
            .github("zigtools/zls", &[
                ("windows", "x86_64", "zls-x86_64-windows.zip"),
                ("windows", "aarch64", "zls-aarch64-windows.zip"),
                ("linux", "x86_64", "zls-x86_64-linux.tar.xz"),
                ("linux", "aarch64", "zls-aarch64-linux.tar.xz"),
                ("macos", "x86_64", "zls-x86_64-macos.tar.xz"),
                ("macos", "aarch64", "zls-aarch64-macos.tar.xz"),
            ], "zls"),
        ServerSpec::new("cmake", "CMake", &["cmake-language-server"], &["cmake"])
            .files(&["cmakelists.txt"])
            .pip(&["cmake-language-server"], "cmake-language-server"),
        ServerSpec::new("fortran", "Fortran (fortls)", &["fortls"], &["f", "f90", "f95", "f03", "f08", "for"])
            .pip(&["fortls"], "fortls"),
        ServerSpec::new("odin", "Odin (ols)", &["ols"], &["odin"])
            .roots(&["ols.json", ".git"])
            .manual("build ols: https://github.com/DanielGavin/ols"),
        ServerSpec::new("d", "D (serve-d)", &["serve-d"], &["d"])
            .roots(&["dub.json", "dub.sdl"])
            .manual("install serve-d: https://github.com/Pure-D/serve-d"),
        ServerSpec::new("nim", "Nim", &["nimlangserver"], &["nim", "nims"])
            .roots(&["*.nimble", ".git"])
            .manual("nimble install nimlangserver"),
        ServerSpec::new("v", "V (v-analyzer)", &["v-analyzer"], &["v"])
            .roots(&["v.mod", ".git"])
            .manual("install v-analyzer: https://github.com/vlang/v-analyzer"),
        ServerSpec::new("crystal", "Crystal (crystalline)", &["crystalline"], &["cr"])
            .roots(&["shard.yml"])
            .manual("install crystalline: https://github.com/elbywan/crystalline"),
        ServerSpec::new("solidity", "Solidity", &["nomicfoundation-solidity-language-server", "--stdio"], &["sol"])
            .roots(&["hardhat.config.ts", "hardhat.config.js", "foundry.toml", "remappings.txt", ".git"])
            .npm(&["@nomicfoundation/solidity-language-server"], "nomicfoundation-solidity-language-server"),
        ServerSpec::new("protobuf", "Protocol Buffers (protols)", &["protols"], &["proto"])
            .cargo("protols", "protols"),
        ServerSpec::new("glsl", "GLSL", &["glsl_analyzer"], &["glsl", "vert", "frag", "comp", "geom", "tesc", "tese"])
            .manual("install glsl_analyzer: https://github.com/nolanderc/glsl_analyzer"),
        // ---- Python
        ServerSpec::new("pyright", "Pyright", &["pyright-langserver", "--stdio"], &["py", "pyi"])
            .roots(&["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".git"])
            .priority(10)
            .settings(r#"{"python":{"analysis":{"autoSearchPaths":true,"useLibraryCodeForTypes":true,"diagnosticMode":"openFilesOnly"}}}"#)
            .npm(&["pyright"], "pyright-langserver"),
        ServerSpec::new("basedpyright", "basedpyright", &["basedpyright-langserver", "--stdio"], &["py", "pyi"])
            .roots(&["pyproject.toml", "pyrightconfig.json", "setup.py", "requirements.txt", ".git"])
            .priority(9)
            .pip(&["basedpyright"], "basedpyright-langserver"),
        ServerSpec::new("pylsp", "python-lsp-server", &["pylsp"], &["py", "pyi"])
            .roots(&["pyproject.toml", "setup.py", "requirements.txt", ".git"])
            .priority(5)
            .pip(&["python-lsp-server"], "pylsp"),
        ServerSpec::new("ruff", "Ruff", &["ruff", "server"], &["py", "pyi"])
            .roots(&["ruff.toml", ".ruff.toml", "pyproject.toml"])
            .linter()
            .pip(&["ruff"], "ruff"),
        // ---- JVM and .NET
        ServerSpec::new("jdtls", "Eclipse JDT (Java)", &["jdtls"], &["java"])
            .roots(&["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", ".classpath", ".git"])
            .manual("install jdtls (Java 21+): https://github.com/eclipse-jdtls/eclipse.jdt.ls"),
        ServerSpec::new("kotlin", "Kotlin", &["kotlin-language-server"], &["kt", "kts"])
            .roots(&["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "pom.xml"])
            .github("fwcd/kotlin-language-server", &[("any", "any", "server.zip")], "kotlin-language-server"),
        ServerSpec::new("scala", "Metals (Scala)", &["metals"], &["scala", "sbt", "sc"])
            .roots(&["build.sbt", "build.sc", "build.mill", ".scala-build"])
            .manual("cs install metals"),
        ServerSpec::new("groovy", "Groovy", &["groovy-language-server"], &["groovy", "gradle"])
            .manual("build groovy-language-server: https://github.com/GroovyLanguageServer/groovy-language-server"),
        ServerSpec::new("clojure", "clojure-lsp", &["clojure-lsp"], &["clj", "cljs", "cljc", "edn", "bb"])
            .roots(&["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"])
            .github("clojure-lsp/clojure-lsp", &[
                ("windows", "any", "clojure-lsp-native-windows-amd64.zip"),
                ("linux", "x86_64", "clojure-lsp-native-static-linux-amd64.zip"),
                ("linux", "aarch64", "clojure-lsp-native-linux-aarch64.zip"),
                ("macos", "x86_64", "clojure-lsp-native-macos-amd64.zip"),
                ("macos", "aarch64", "clojure-lsp-native-macos-aarch64.zip"),
            ], "clojure-lsp"),
        ServerSpec::new("csharp", "C# (csharp-ls)", &["csharp-ls"], &["cs", "csx"])
            .roots(&["*.sln", "*.slnx", "*.csproj", "global.json"])
            .priority(10)
            .dotnet("csharp-ls", "csharp-ls"),
        ServerSpec::new("omnisharp", "OmniSharp", &["OmniSharp", "-lsp"], &["cs", "csx"])
            .roots(&["*.sln", "*.csproj", "omnisharp.json"])
            .priority(5)
            .manual("install OmniSharp: https://github.com/OmniSharp/omnisharp-roslyn"),
        ServerSpec::new("fsharp", "F# (FsAutoComplete)", &["fsautocomplete", "--adaptive-lsp-server-enabled"], &["fs", "fsi", "fsx", "fsscript"])
            .roots(&["*.sln", "*.fsproj", "global.json"])
            .init(r#"{"AutomaticWorkspaceInit":true}"#)
            .dotnet("fsautocomplete", "fsautocomplete"),
        ServerSpec::new("powershell", "PowerShell", &["pwsh", "-NoLogo", "-NoProfile", "-Command", "Import-Module PowerShellEditorServices; Start-EditorServices -Stdio -HostName jean -HostProfileId jean -HostVersion 1.0.0 -LogLevel Warning"], &["ps1", "psm1", "psd1"])
            .manual("Install-Module PowerShellEditorServices"),
        // ---- Functional and BEAM
        ServerSpec::new("haskell", "Haskell (HLS)", &["haskell-language-server-wrapper", "--lsp"], &["hs", "lhs"])
            .roots(&["hie.yaml", "stack.yaml", "cabal.project", "*.cabal", "package.yaml"])
            .manual("ghcup install hls"),
        ServerSpec::new("ocaml", "OCaml (ocamllsp)", &["ocamllsp"], &["ml", "mli", "re", "rei"])
            .roots(&["dune-project", "dune-workspace", "*.opam", "esy.json", "_opam"])
            .manual("opam install ocaml-lsp-server"),
        ServerSpec::new("elixir", "ElixirLS", &["elixir-ls"], &["ex", "exs", "heex", "eex"])
            .roots(&["mix.exs"])
            .github("elixir-lsp/elixir-ls", &[("any", "any", "elixir-ls-v*.zip")], if cfg!(windows) { "language_server.bat" } else { "language_server.sh" }),
        ServerSpec::new("erlang", "Erlang (ELP)", &["elp", "server"], &["erl", "hrl"])
            .roots(&["rebar.config", "erlang.mk", "elp.toml"])
            .manual("install ELP: https://github.com/WhatsApp/erlang-language-platform"),
        ServerSpec::new("gleam", "Gleam", &["gleam", "lsp"], &["gleam"])
            .roots(&["gleam.toml"])
            .manual("install Gleam: https://gleam.run"),
        ServerSpec::new("elm", "Elm", &["elm-language-server"], &["elm"])
            .roots(&["elm.json"])
            .npm(&["@elm-tooling/elm-language-server"], "elm-language-server"),
        ServerSpec::new("purescript", "PureScript", &["purescript-language-server", "--stdio"], &["purs"])
            .roots(&["spago.dhall", "spago.yaml", "bower.json"])
            .npm(&["purescript-language-server"], "purescript-language-server"),
        ServerSpec::new("racket", "Racket", &["racket", "-l", "racket-langserver"], &["rkt"])
            .manual("raco pkg install racket-langserver"),
        ServerSpec::new("lean", "Lean", &["lake", "serve"], &["lean"])
            .roots(&["lakefile.lean", "lakefile.toml", "lean-toolchain"])
            .manual("install Lean via elan: https://lean-lang.org"),
        // ---- Scripting
        ServerSpec::new("lua", "lua-language-server", &["lua-language-server"], &["lua"])
            .roots(&[".luarc.json", ".luarc.jsonc", ".stylua.toml", "stylua.toml", "selene.toml", ".git"])
            .settings(r#"{"Lua":{"telemetry":{"enable":false},"workspace":{"checkThirdParty":false}}}"#)
            .github("LuaLS/lua-language-server", &[
                ("windows", "x86_64", "lua-language-server-*-win32-x64.zip"),
                ("linux", "x86_64", "lua-language-server-*-linux-x64.tar.gz"),
                ("linux", "aarch64", "lua-language-server-*-linux-arm64.tar.gz"),
                ("macos", "x86_64", "lua-language-server-*-darwin-x64.tar.gz"),
                ("macos", "aarch64", "lua-language-server-*-darwin-arm64.tar.gz"),
            ], "lua-language-server"),
        ServerSpec::new("ruby-lsp", "Ruby LSP", &["ruby-lsp"], &["rb", "rake", "gemspec", "ru"])
            .files(&["gemfile", "rakefile", "podfile"])
            .roots(&["Gemfile", ".ruby-version", ".git"])
            .priority(10)
            .gem("ruby-lsp", "ruby-lsp"),
        ServerSpec::new("solargraph", "Solargraph", &["solargraph", "stdio"], &["rb", "rake", "gemspec", "ru"])
            .roots(&["Gemfile", ".git"])
            .priority(5)
            .gem("solargraph", "solargraph"),
        ServerSpec::new("rubocop", "RuboCop", &["rubocop", "--lsp"], &["rb", "rake", "gemspec", "ru"])
            .roots(&[".rubocop.yml"])
            .linter()
            .gem("rubocop", "rubocop"),
        ServerSpec::new("php", "PHP (Intelephense)", &["intelephense", "--stdio"], &["php", "phtml"])
            .roots(&["composer.json", ".git"])
            .init(r#"{"storagePath":"${toolsDir}/intelephense"}"#)
            .npm(&["intelephense"], "intelephense"),
        ServerSpec::new("perl", "Perl Navigator", &["perlnavigator", "--stdio"], &["pl", "pm", "t"])
            .npm(&["perlnavigator-server"], "perlnavigator"),
        ServerSpec::new("r", "R languageserver", &["R", "--no-echo", "-e", "languageserver::run()"], &["r", "rmd"])
            .roots(&["DESCRIPTION", "*.Rproj", ".git"])
            .manual("install.packages(\"languageserver\")"),
        ServerSpec::new("julia", "Julia", &["julia", "--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"], &["jl"])
            .roots(&["Project.toml", "JuliaProject.toml"])
            .manual("julia -e 'using Pkg; Pkg.add(\"LanguageServer\")'"),
        ServerSpec::new("nushell", "Nushell", &["nu", "--lsp"], &["nu"])
            .manual("install Nushell: https://www.nushell.sh"),
        ServerSpec::new("dart", "Dart", &["dart", "language-server", "--protocol=lsp"], &["dart"])
            .roots(&["pubspec.yaml"])
            .manual("install the Dart or Flutter SDK"),
        ServerSpec::new("swift", "SourceKit-LSP", &["sourcekit-lsp"], &["swift", "objc", "objcpp"])
            .roots(&["Package.swift", "*.xcodeproj", "*.xcworkspace", "buildServer.json"])
            .manual("install the Swift toolchain (Xcode on macOS)"),
        // ---- Infrastructure and documents
        ServerSpec::new("terraform", "terraform-ls", &["terraform-ls", "serve"], &["tf", "tfvars", "hcl"])
            .roots(&[".terraform", "*.tf", ".git"])
            .go("github.com/hashicorp/terraform-ls@latest", "terraform-ls"),
        ServerSpec::new("nix", "nixd", &["nixd"], &["nix"])
            .roots(&["flake.nix", "default.nix", "shell.nix"])
            .priority(10)
            .manual("nix profile install nixpkgs#nixd"),
        ServerSpec::new("nil", "nil", &["nil"], &["nix"])
            .roots(&["flake.nix", "default.nix", "shell.nix"])
            .priority(5)
            .cargo("nil", "nil"),
        ServerSpec::new("texlab", "TexLab", &["texlab"], &["tex", "bib", "sty", "cls", "latex"])
            .roots(&[".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot", ".git"])
            .github("latex-lsp/texlab", &[
                ("windows", "x86_64", "texlab-x86_64-windows.zip"),
                ("linux", "x86_64", "texlab-x86_64-linux.tar.gz"),
                ("linux", "aarch64", "texlab-aarch64-linux.tar.gz"),
                ("macos", "x86_64", "texlab-x86_64-macos.tar.gz"),
                ("macos", "aarch64", "texlab-aarch64-macos.tar.gz"),
            ], "texlab"),
        ServerSpec::new("typst", "Tinymist (Typst)", &["tinymist", "lsp"], &["typ", "typc"])
            .roots(&["typst.toml", ".git"])
            .github("Myriad-Dreamin/tinymist", &[
                ("windows", "x86_64", "tinymist-win32-x64.exe"),
                ("linux", "x86_64", "tinymist-linux-x64"),
                ("linux", "aarch64", "tinymist-linux-arm64"),
                ("macos", "x86_64", "tinymist-darwin-x64"),
                ("macos", "aarch64", "tinymist-darwin-arm64"),
            ], "tinymist"),
        ServerSpec::new("xml", "LemMinX (XML)", &["lemminx"], &["xml", "xsd", "xsl", "xslt", "svg", "pom"])
            .manual("install LemMinX: https://github.com/eclipse/lemminx"),
        ServerSpec::new("ansible", "Ansible", &["ansible-language-server", "--stdio"], &["yaml", "yml"])
            .roots(&["ansible.cfg", ".ansible-lint"])
            .linter()
            .npm(&["@ansible/ansible-language-server"], "ansible-language-server"),
        ServerSpec::new("helm", "Helm", &["helm_ls", "serve"], &["tpl"])
            .roots(&["Chart.yaml"])
            .manual("install helm-ls: https://github.com/mrjosh/helm-ls"),
        ServerSpec::new("just", "just", &["just-lsp"], &[])
            .files(&["justfile", ".justfile"])
            .cargo("just-lsp", "just-lsp"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_is_large_and_unique() {
        let servers = builtin_servers();
        assert!(servers.len() >= 60, "{} servers", servers.len());
        let mut ids: Vec<&str> = servers.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate ids");
        // Every literal parsed (a typo would have panicked building the list).
        assert!(servers.iter().all(|s| !s.command.is_empty()));
    }

    #[test]
    fn handles_by_extension_and_by_name() {
        let servers = builtin_servers();
        let find = |id: &str| servers.iter().find(|s| s.id == id).unwrap();
        assert!(find("typescript").handles(Path::new("src/App.tsx")));
        assert!(find("dockerfile").handles(Path::new("Dockerfile")));
        assert!(find("gopls").handles(Path::new("go.mod")));
        assert!(!find("gopls").handles(Path::new("main.rs")));
    }

    #[test]
    fn user_config_layers_over_a_builtin() {
        let base = builtin_servers().into_iter().find(|s| s.id == "typescript").unwrap();
        let custom = base.with_config(&literal(
            r#"{"command":["my-ts","--stdio"],"extensions":[".ts"],"env":{"A":"1"},"settings":{"x":{"y":true}},"initialization":{"preferences":{"quotePreference":"single"}}}"#,
        ));
        assert_eq!(custom.command, vec!["my-ts", "--stdio"]);
        assert_eq!(custom.extensions, vec!["ts"]);
        assert_eq!(custom.env, vec![("A".to_string(), "1".to_string())]);
        assert_eq!(custom.settings.bool_at("x.y"), Some(true));
        // Merged, not replaced: the built-in preference survives.
        assert_eq!(custom.initialization.bool_at("preferences.includeCompletionsForModuleExports"), Some(true));
        assert_eq!(custom.initialization.str_at("preferences.quotePreference"), Some("single"));
    }

    #[test]
    fn a_server_can_come_entirely_from_config() {
        let spec = ServerSpec::from_config("mylang", &literal(r#"{"command":["mylang-ls"],"extensions":["ml2"]}"#)).unwrap();
        assert!(spec.handles(Path::new("a.ml2")));
        assert!(ServerSpec::from_config("empty", &literal("{}")).is_none());
    }
}
