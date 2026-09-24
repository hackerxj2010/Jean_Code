//! File to LSP language identifier.
//!
//! The identifiers are the ones in the specification's `TextDocumentItem`
//! table, plus the conventional ones for languages it does not list. Servers
//! key behaviour off them: send `javascript` for a `.jsx` file and the
//! TypeScript server declines to parse its JSX.

use std::path::Path;

const BY_EXTENSION: &[(&str, &str)] = &[
    ("abap", "abap"), ("ada", "ada"), ("adb", "ada"), ("ads", "ada"), ("astro", "astro"), ("awk", "awk"),
    ("bash", "shellscript"), ("bat", "bat"), ("bib", "bibtex"), ("c", "c"), ("cc", "cpp"), ("cjs", "javascript"),
    ("cls", "latex"), ("clj", "clojure"), ("cljc", "clojure"), ("cljs", "clojure"), ("cmake", "cmake"),
    ("coffee", "coffeescript"), ("cpp", "cpp"), ("cr", "crystal"), ("cs", "csharp"), ("cshtml", "razor"),
    ("css", "css"), ("csx", "csharp"), ("cts", "typescript"), ("cxx", "cpp"), ("d", "d"), ("dart", "dart"),
    ("diff", "diff"), ("dockerfile", "dockerfile"), ("edn", "clojure"), ("elm", "elm"), ("erl", "erlang"),
    ("ex", "elixir"), ("exs", "elixir"), ("f", "fortran"), ("f03", "fortran"), ("f08", "fortran"),
    ("f90", "fortran"), ("f95", "fortran"), ("for", "fortran"), ("fs", "fsharp"), ("fsi", "fsharp"),
    ("fsscript", "fsharp"), ("fsx", "fsharp"), ("gd", "gdscript"), ("gemspec", "ruby"), ("gleam", "gleam"),
    ("glsl", "glsl"), ("go", "go"), ("gql", "graphql"), ("graphql", "graphql"), ("groovy", "groovy"),
    ("h", "c"), ("handlebars", "handlebars"), ("hbs", "handlebars"), ("hcl", "hcl"), ("heex", "phoenix-heex"),
    ("hh", "cpp"), ("hpp", "cpp"), ("hrl", "erlang"), ("hs", "haskell"), ("htm", "html"), ("html", "html"),
    ("hxx", "cpp"), ("ini", "ini"), ("ipynb", "python"), ("java", "java"), ("jl", "julia"), ("js", "javascript"),
    ("json", "json"), ("json5", "json5"), ("jsonc", "jsonc"), ("jsx", "javascriptreact"), ("kt", "kotlin"),
    ("kts", "kotlin"), ("ksh", "shellscript"), ("latex", "latex"), ("lean", "lean"), ("less", "less"),
    ("lhs", "haskell"), ("lua", "lua"), ("m", "objective-c"), ("markdown", "markdown"), ("md", "markdown"),
    ("mdx", "mdx"), ("mjs", "javascript"), ("ml", "ocaml"), ("mli", "ocaml"), ("mm", "objective-cpp"),
    ("mts", "typescript"), ("nim", "nim"), ("nims", "nim"), ("nix", "nix"), ("nu", "nushell"), ("odin", "odin"),
    ("pas", "pascal"), ("php", "php"), ("pl", "perl"), ("pm", "perl"), ("prisma", "prisma"),
    ("proto", "proto"), ("ps1", "powershell"), ("psd1", "powershell"), ("psm1", "powershell"),
    ("purs", "purescript"), ("py", "python"), ("pyi", "python"), ("r", "r"), ("rake", "ruby"),
    ("razor", "razor"), ("rb", "ruby"), ("re", "reason"), ("rei", "reason"), ("res", "rescript"),
    ("rkt", "racket"), ("rmd", "rmd"), ("rs", "rust"), ("ru", "ruby"), ("sass", "sass"), ("sbt", "scala"),
    ("sc", "scala"), ("scala", "scala"), ("scm", "scheme"), ("scss", "scss"), ("sh", "shellscript"),
    ("sol", "solidity"), ("sql", "sql"), ("sty", "latex"), ("svelte", "svelte"), ("swift", "swift"),
    ("tex", "latex"), ("tf", "terraform"), ("tfvars", "terraform-vars"), ("toml", "toml"),
    ("ts", "typescript"), ("tsx", "typescriptreact"), ("typ", "typst"), ("typc", "typst"), ("v", "v"),
    ("vb", "vb"), ("vim", "vim"), ("vue", "vue"), ("xml", "xml"), ("xsd", "xml"), ("xsl", "xml"),
    ("yaml", "yaml"), ("yml", "yaml"), ("zig", "zig"), ("zon", "zig"), ("zsh", "shellscript"),
];

/// Files whose language is decided by their whole name.
const BY_NAME: &[(&str, &str)] = &[
    ("dockerfile", "dockerfile"), ("containerfile", "dockerfile"), ("makefile", "makefile"),
    ("gnumakefile", "makefile"), ("gemfile", "ruby"), ("rakefile", "ruby"), ("podfile", "ruby"),
    ("cmakelists.txt", "cmake"), ("go.mod", "go.mod"), ("go.sum", "go.sum"), ("go.work", "go.work"),
    ("justfile", "just"), (".bashrc", "shellscript"), (".zshrc", "shellscript"), (".vimrc", "vim"),
    ("docker-compose.yml", "dockercompose"), ("docker-compose.yaml", "dockercompose"),
    ("compose.yml", "dockercompose"), ("compose.yaml", "dockercompose"),
];

/// The file name, lower-cased.
pub fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The extension without its dot, lower-cased; `""` when there is none.
pub fn extension_of(path: &Path) -> String {
    path.extension().map(|ext| ext.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The LSP language id for a file, if it is one this table knows.
pub fn language_of(path: &Path) -> Option<&'static str> {
    let name = file_name(path);
    if let Some((_, language)) = BY_NAME.iter().find(|(known, _)| *known == name) {
        return Some(language);
    }
    // `Dockerfile.dev`, `app.dockerfile`.
    if name.starts_with("dockerfile.") || name.starts_with("containerfile.") {
        return Some("dockerfile");
    }
    let extension = extension_of(path);
    BY_EXTENSION.iter().find(|(known, _)| *known == extension).map(|(_, language)| *language)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_names_and_variants() {
        assert_eq!(language_of(Path::new("src/App.TSX")), Some("typescriptreact"));
        assert_eq!(language_of(Path::new("Dockerfile")), Some("dockerfile"));
        assert_eq!(language_of(Path::new("deploy/Dockerfile.prod")), Some("dockerfile"));
        assert_eq!(language_of(Path::new("CMakeLists.txt")), Some("cmake"));
        assert_eq!(language_of(Path::new("notes.unknownext")), None);
    }
}
