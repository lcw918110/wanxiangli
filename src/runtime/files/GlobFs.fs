namespace Wanxiangli.Fs

open Wanxiangli.Fs.Native

/// 有界工作树的确定性 gitignore 感知枚举：遵守各级 `.gitignore` 与
/// `.git/info/exclude`，不进入 `.git`，不跟随符号链接，结果排序。
module GlobFs =

    module private List =
        let sequenceResult (results: Result<'a, 'e> list) : Result<'a list, 'e> =
            let folder head tail =
                match head, tail with
                | Ok h, Ok t -> Ok(h :: t)
                | Error e, _ -> Error e
                | _, Error e -> Error e

            List.foldBack folder results (Ok [])

    type private IgnoreRule =
        { Base: string
          Regex: obj
          Negated: bool
          DirectoryOnly: bool }

    let private splitTopCommas (inner: string) : string list =
        let rec go (chars: char list) (depth: int) (buf: string) (acc: string list) =
            match chars with
            | [] -> List.rev (buf :: acc)
            | '{' :: rest -> go rest (depth + 1) (buf + "{") acc
            | '}' :: rest -> go rest (max 0 (depth - 1)) (buf + "}") acc
            | ',' :: rest when depth = 0 -> go rest 0 "" (buf :: acc)
            | c :: rest -> go rest depth (buf + string c) acc

        go (List.ofSeq inner) 0 "" []

    let private findBraceGroup (s: string) : (string * string list * string) option =
        let rec scan (i: int) (depth: int) (start: int) =
            if i >= s.Length then
                None
            else
                match s[i] with
                | '{' when depth = 0 -> scan (i + 1) 1 i
                | '{' -> scan (i + 1) (depth + 1) start
                | '}' when depth = 1 && start >= 0 ->
                    Some(
                        s.Substring(0, start),
                        splitTopCommas (s.Substring(start + 1, i - start - 1)),
                        s.Substring(i + 1)
                    )
                | '}' when depth > 1 -> scan (i + 1) (depth - 1) start
                | _ -> scan (i + 1) depth start

        scan 0 0 -1

    let rec private expandBraces (pattern: string) : string list =
        match findBraceGroup pattern with
        | None -> [ pattern ]
        | Some(before, alts, after) -> alts |> List.collect (fun alt -> expandBraces (before + alt + after))

    let private compilePathPattern (pattern: string) : Result<obj, FsFailure> =
        GlobMatch.compilePattern pattern
        |> Result.mapError (fun _ -> failure "INVALID_ANCHOR_PATTERN" "anchor RegExp is invalid")

    let private compileUserPatterns (pattern: string) : Result<obj array, FsFailure> =
        if System.String.IsNullOrEmpty pattern then
            Error(failure "INVALID_ANCHOR_PATTERN" "anchor RegExp is invalid")
        else
            expandBraces pattern
            |> List.map compilePathPattern
            |> List.sequenceResult
            |> Result.map Array.ofList

    let private parseIgnoreBody (baseRel: string) (negated: bool) (body: string) : IgnoreRule option =
        let directoryOnly = body.EndsWith("/")

        let spec =
            if directoryOnly then
                body.Substring(0, body.Length - 1)
            else
                body

        compilePathPattern spec
        |> Result.toOption
        |> Option.map (fun re ->
            { Base = baseRel
              Regex = re
              Negated = negated
              DirectoryOnly = directoryOnly })

    let private parseIgnoreLine (baseRel: string) (raw: string) : IgnoreRule option =
        let line =
            if raw.EndsWith("\r") then
                raw.Substring(0, raw.Length - 1)
            else
                raw

        let trimmed = line.Trim()
        let negated = trimmed.StartsWith("!")
        let body = if negated then trimmed.Substring(1) else trimmed

        if trimmed = "" || trimmed.StartsWith("#") || body = "" then
            None
        else
            parseIgnoreBody baseRel negated body

    let private loadIgnoreFile (filePath: string) (baseRel: string) : IgnoreRule list =
        match Utf8Fs.readUtf8 filePath with
        | Error _ -> []
        | Ok text -> text.Split([| '\n' |]) |> Array.toList |> List.choose (parseIgnoreLine baseRel)

    let private localIgnorePath (ruleBase: string) (rel: string) : string option =
        if ruleBase = "" then
            Some rel
        elif rel = ruleBase then
            Some ""
        elif rel.StartsWith(ruleBase + "/") then
            Some(rel.Substring(ruleBase.Length + 1))
        else
            None

    let private isIgnored (rules: ResizeArray<IgnoreRule>) (rel: string) (isDir: bool) : bool =
        let rec go i ignored =
            if i >= rules.Count then
                ignored
            else
                let rule = rules[i]

                let skip =
                    (rule.DirectoryOnly && not isDir)
                    || (match localIgnorePath rule.Base rel with
                        | None -> true
                        | Some "" -> true
                        | Some path -> not (GlobMatch.testCompiled rule.Regex path))

                if skip then
                    go (i + 1) ignored
                else
                    go (i + 1) (not rule.Negated)

        go 0 false

    type private VisibleEntry =
        | SkipEntry
        | RecurseDirectory of full: string * childRel: string
        | EmitFile of childRel: string

    let private tryListDirectory (dir: string) : string list =
        try
            readdirSync dir |> Array.toList |> List.sort
        with _ ->
            []

    let private tryLstat (full: string) : obj option =
        try
            Some(lstatSync full)
        with _ ->
            None

    let private classifyStatKind
        (rules: ResizeArray<IgnoreRule>)
        (childRel: string)
        (full: string)
        (st: obj)
        : VisibleEntry =
        if isSymbolicLink st then
            SkipEntry
        elif isDirectory st && isIgnored rules childRel true then
            SkipEntry
        elif isDirectory st then
            RecurseDirectory(full, childRel)
        elif isFile st && isIgnored rules childRel false then
            SkipEntry
        elif isFile st then
            EmitFile childRel
        else
            SkipEntry

    let private visibleEntry
        (rules: ResizeArray<IgnoreRule>)
        (rel: string)
        (dir: string)
        (entry: string)
        : VisibleEntry =
        if entry = ".git" then
            SkipEntry
        else
            let full = pathJoin dir entry
            let childRel = if rel = "" then entry else rel + "/" + entry

            match tryLstat full with
            | None -> SkipEntry
            | Some st -> classifyStatKind rules childRel full st

    type VisibleListingEntry = { Name: string; IsDir: bool }

    let private classifyReadDirectoryFailure (path: string) (ex: obj) : FsFailure =
        let code = string (Fable.Core.JsInterop.(?) ex "code": obj)

        if code = "ENOENT" then
            failure "FILE_NOT_FOUND" ("target file does not exist: " + path)
        else
            failure "FILE_READ_FAILED" ("file read failed: " + path)

    let private resolveInsideRoot (root: string) (path: string) : Result<string * string, FsFailure> =
        let resolvedRoot = pathResolve root

        let resolved =
            if pathIsAbsolute path then
                pathResolve path
            else
                pathResolve (pathJoin root path)

        let inside (candidate: string) : bool =
            candidate = resolvedRoot || candidate.StartsWith(resolvedRoot + "/")

        let rec firstExisting (candidate: string) : string =
            let present =
                try
                    existsSync candidate
                with _ ->
                    false

            if present then
                candidate
            else
                let parent = pathDirname candidate

                if parent = candidate then
                    candidate
                else
                    firstExisting parent

        let denied = failure "PATH_DENIED" ("path outside capability boundary: " + path)

        try
            let realRoot = realpathSync resolvedRoot
            let insideRealRoot (candidate: string) =
                candidate = realRoot || candidate.StartsWith(realRoot + "/")

            let existing = firstExisting resolved
            let real = realpathSync existing
            let suffix = resolved.Substring(existing.Length)

            if inside resolved && insideRealRoot real && insideRealRoot (real + suffix) then
                let rel =
                    if resolved = resolvedRoot then
                        ""
                    elif resolved.StartsWith(resolvedRoot + "/") then
                        resolved.Substring(resolvedRoot.Length + 1).Replace('\\', '/')
                    else
                        path.Replace('\\', '/').Trim('/')

                Ok(resolved, rel)
            else
                Error denied
        with _ ->
            Error denied

    let private buildIgnoreRulesForDirectory (root: string) (rel: string) : ResizeArray<IgnoreRule> =
        let rules = ResizeArray<IgnoreRule>()

        for rule in loadIgnoreFile (pathJoin root ".git/info/exclude") "" do
            rules.Add(rule)

        for rule in loadIgnoreFile (pathJoin root ".gitignore") "" do
            rules.Add(rule)

        if rel <> "" then
            let segments = rel.Split([| '/' |]) |> Array.filter (fun s -> s <> "")
            let mutable curRel = ""

            for seg in segments do
                curRel <- if curRel = "" then seg else curRel + "/" + seg
                let curDir = pathJoin root curRel

                for rule in loadIgnoreFile (pathJoin curDir ".gitignore") curRel do
                    rules.Add(rule)

        rules

    /// 单目录确定性 gitignore 感知枚举（非递归）：返回直接子项的名称与目录标记。
    let visibleEntries (root: string) (path: string) : Result<VisibleListingEntry list, FsFailure> =
        match resolveInsideRoot root path with
        | Error e -> Error e
        | Ok(full, rel) ->
            try
                let names = readdirSync full |> Array.toList |> List.sort
                let rules = buildIgnoreRulesForDirectory root rel

                let entries =
                    names
                    |> List.choose (fun entry ->
                        match visibleEntry rules rel full entry with
                        | SkipEntry -> None
                        | RecurseDirectory _ -> Some { Name = entry; IsDir = true }
                        | EmitFile _ -> Some { Name = entry; IsDir = false })

                Ok entries
            with ex ->
                Error(classifyReadDirectoryFailure path (box ex))

    let private collectVisibleFiles (root: string) : System.Threading.Tasks.Task<string list> =
        // DSL-MUTABLE: algorithm-scratch — visible file accumulator
        let files = ResizeArray<string>()
        let rules = ResizeArray<IgnoreRule>()

        let rec walk (dir: string) (rel: string) : System.Threading.Tasks.Task<unit> =
            task {
                let nested = loadIgnoreFile (pathJoin dir ".gitignore") rel
                let mark = rules.Count

                let rootExcludes =
                    if rel = "" then
                        loadIgnoreFile (pathJoin root ".git/info/exclude") ""
                    else
                        []

                for rule in rootExcludes do
                    rules.Add(rule)

                for rule in nested do
                    rules.Add(rule)

                do! yieldEventLoop ()

                try
                    let entries = tryListDirectory dir

                    for entry in entries do
                        match visibleEntry rules rel dir entry with
                        | SkipEntry -> ()
                        | RecurseDirectory(full, childRel) -> do! walk full childRel
                        | EmitFile childRel ->
                            files.Add(childRel.Replace('\\', '/'))
                            do! yieldEventLoop ()
                finally
                    rules.RemoveRange(mark, rules.Count - mark)
            }

        task {
            do! walk root ""
            return List.ofSeq files
        }

    /// 完整确定性枚举，内部不截断；超限由调用方的结果边界处理。
    let glob (root: string) (pattern: string) : System.Threading.Tasks.Task<Result<string list, FsFailure>> =
        task {
            match compileUserPatterns pattern with
            | Error e -> return Error e
            | Ok compiledMatchers ->
                let! visible = collectVisibleFiles root

                let paths =
                    visible
                    |> List.filter (fun rel -> Array.exists (fun re -> GlobMatch.testCompiled re rel) compiledMatchers)
                    |> List.sort

                return Ok paths
        }
