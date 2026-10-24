namespace Wanxiangli.Fs

open Wanxiangli.Fs.Native

/// 路径解析、边界拦截与原子写盘/回滚。写盘先写同目录内容再落盘；
/// 失败按预期当前内容比对回滚，绝不覆盖第三方修改。
module MutationFs =

    /// 相对路径并入 root；绝对路径按原样解析。
    let resolveToolPath (root: string) (path: string) : string =
        if pathIsAbsolute path then
            pathResolve path
        else
            pathResolve (pathJoin root path)

    /// 边界拦截：解析后的真实路径（含符号链接展开）必须仍在 root 之内，
    /// 否则 PATH_DENIED。`..` 逃逸与指向根外的符号链接在此拒绝。
    /// 目标或其祖先尚不存在时，对最深已存在的祖先做 realpath 校验，
    /// 剩余未创建段保持纯解析（无 `..`，不会逃逸）。
    let resolveBounded (root: string) (path: string) : Result<string, FsFailure> =
        let resolvedRoot = pathResolve root
        let resolved = resolveToolPath root path

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
                Ok resolved
            else
                Error denied
        with _ ->
            Error denied

    /// 存在性探测。
    let existsPath (path: string) : bool =
        try
            existsSync path
        with _ ->
            false

    let private removeIfPresent (full: string) : unit =
        if existsSync full then
            unlinkSync full

    let private applyRestore (full: string) (restoreTo: string option) : unit =
        match restoreTo with
        | Some text -> writeFileSync full text
        | None -> removeIfPresent full

    let private readCurrent (full: string) : string option =
        match Utf8Fs.readUtf8Classified full with
        | Ok text -> Some text
        | Error _ -> None

    /// 仅当磁盘当前内容等于 expectedCurrent 时才还原 restoreTo。
    /// 第三方修改被保留，绝不盲目覆盖。
    let undoIfMatches (resolvedPath: string) (expectedCurrent: string) (restoreTo: string option) : unit =
        match readCurrent resolvedPath with
        | Some current when current = expectedCurrent ->
            try
                applyRestore resolvedPath restoreTo
            with _ ->
                ()
        | _ -> ()

    type private ResolvedMutation =
        | ResolvedRewrite of resolvedPath: string * expectedCurrent: string * newText: string
        | ResolvedCreate of path: string * resolvedPath: string * newText: string

    let private validateOne (mutation: ResolvedMutation) : FsFailure option =
        match mutation with
        | ResolvedRewrite(resolvedPath, expectedCurrent, _) ->
            match readCurrent resolvedPath with
            | Some current when current = expectedCurrent -> None
            | _ -> Some(failure "FILE_CHANGED" "target changed since the read snapshot; no implicit retry")
        | ResolvedCreate(path, resolvedPath, _) when existsPath resolvedPath ->
            Some(failure "FILE_CHANGED" ("target changed since the read snapshot; no implicit retry: " + path))
        | ResolvedCreate _ -> None

    let private writeOne (mutation: ResolvedMutation) : Result<ResolvedMutation, FsFailure> =
        match
            (match validateOne mutation with
             | Some e -> Error e
             | None -> Ok mutation)
        with
        | Error e -> Error e
        | Ok validated ->
            match validated with
            | ResolvedRewrite(resolvedPath, expectedCurrent, newText) ->
                try
                    writeFileSync resolvedPath newText
                    Ok(ResolvedRewrite(resolvedPath, expectedCurrent, newText))
                with _ ->
                    Error(failure "TRANSACTION_COMMIT_FAILED" "transaction commit failed")
            | ResolvedCreate(path, resolvedPath, newText) ->
                try
                    writeFileWithOptions resolvedPath newText (objectOf [| "encoding", box "utf8"; "flag", box "wx" |])
                    Ok(ResolvedCreate(path, resolvedPath, newText))
                with
                | _ when existsPath resolvedPath ->
                    Error(failure "FILE_CHANGED" ("target changed since the read snapshot; no implicit retry: " + path))
                | _ -> Error(failure "TRANSACTION_COMMIT_FAILED" "transaction commit failed")

    let private rollbackResolved (_root: string) (mutation: ResolvedMutation) : unit =
        match mutation with
        | ResolvedRewrite(resolvedPath, expectedCurrent, newText) ->
            undoIfMatches resolvedPath newText (Some expectedCurrent)
        | ResolvedCreate(_, resolvedPath, writtenText) -> undoIfMatches resolvedPath writtenText None

    let private resolveMutation (root: string) (mutation: Transaction.StagedMutation) : ResolvedMutation =
        match mutation with
        | Transaction.Rewrite(path, originalText, newText) ->
            ResolvedRewrite(resolveToolPath root path, originalText, newText)
        | Transaction.Create(path, text) -> ResolvedCreate(path, resolveToolPath root path, text)

    /// 全有或全无提交：先拒绝同路径多意图（零文件效果），
    /// 再逐条写入；任一写入失败即回滚本次已写文件。
    let commitStaged (root: string) (mutations: Transaction.StagedMutation list) : Result<unit, FsFailure> =
        match Transaction.validateSingleIntent mutations with
        | Error e -> Error e
        | Ok single ->
            let apply mutations' =
                let rec go remaining applied =
                    match remaining with
                    | [] -> Ok()
                    | mutation :: rest ->
                        match writeOne mutation with
                        | Ok written -> go rest (written :: applied)
                        | Error failure ->
                            applied |> List.iter (rollbackResolved root)
                            Error failure

                go (mutations' |> List.map (resolveMutation root)) []

            apply single

    /// 按回滚计划还原（崩溃恢复路径由调用方持有 durable 事实）。
    let rollbackStaged (root: string) (mutations: Transaction.StagedMutation list) : unit =
        mutations
        |> List.map (resolveMutation root)
        |> List.iter (rollbackResolved root)
