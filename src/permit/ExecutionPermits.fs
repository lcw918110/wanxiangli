namespace Wanxiangli.Permit

open System
open System.Collections.Generic
open Fable.Core
open Fable.Core.JsInterop

module internal Wire =

    [<Emit("typeof $0 === 'string'")>]
    let isString (_value: obj) : bool = jsNative

    [<Emit("typeof $0 === 'number' && Number.isSafeInteger($0) && $0 > 0")>]
    let isPositiveInteger (_value: obj) : bool = jsNative

    [<Emit("$0 == null")>]
    let isNullish (_value: obj) : bool = jsNative

    [<Emit("Object.freeze($0)")>]
    let freeze (_value: obj) : obj = jsNative

    [<Emit("new WeakSet()")>]
    let weakSet () : obj = jsNative

    [<Emit("$0.add($1)")>]
    let add (_set: obj) (_value: obj) : unit = jsNative

    [<Emit("(typeof $1 === 'object' && $1 !== null && $0.has($1))")>]
    let has (_set: obj) (_value: obj) : bool = jsNative

    [<Emit("$0 === $1")>]
    let same (_left: obj) (_right: obj) : bool = jsNative

/// 一次物理执行的精确身份：会话、物理用户消息、角色、参与者与已解析 target。
type internal Identity =
    { SessionId: string
      PhysicalUserMessageId: string
      Role: string
      Participant: string
      Model: string
      Reasoning: string }

module internal Identity =

    let private fail (message: string) : 'a =
        raise (InvalidOperationException("execution-model-routing: " + message))

    let private text (owner: string) (name: string) (value: obj) =
        if Wire.isString value then
            unbox<string> value
        else
            fail (sprintf "%s requires string %s" owner name)

    let decode (owner: string) (value: obj) : Identity =
        if Wire.isNullish value then
            fail (sprintf "%s requires an exact execution identity" owner)

        let target: obj = value?target

        if Wire.isNullish target then
            fail (sprintf "%s requires target" owner)

        { SessionId = text owner "sessionId" (value?sessionId: obj)
          PhysicalUserMessageId = text owner "physicalUserMessageId" (value?physicalUserMessageId: obj)
          Role = text owner "role" (value?role: obj)
          Participant = text owner "participant" (value?participant: obj)
          Model = text owner "target.model" (target?model: obj)
          Reasoning = text owner "target.reasoning" (target?reasoning: obj) }

    let encode (identity: Identity) : obj =
        Wire.freeze (
            createObj
                [ "sessionId" ==> identity.SessionId
                  "physicalUserMessageId" ==> identity.PhysicalUserMessageId
                  "role" ==> identity.Role
                  "participant" ==> identity.Participant
                  "target"
                  ==> Wire.freeze (createObj [ "model" ==> identity.Model; "reasoning" ==> identity.Reasoning ]) ]
        )

[<RequireQualifiedAccess>]
type internal Release =
    | BeforeProvider
    | PhysicalCompletion

[<RequireQualifiedAccess>]
type internal State =
    | Pending
    | Committed
    | Releasing of Release
    | Released of Release

[<RequireQualifiedAccess>]
type internal Rejection =
    | UnknownLease
    | WrongFence
    | StaleLease
    | WrongSession
    | WrongPhysicalUserMessage
    | WrongRole
    | WrongParticipant
    | WrongTarget
    | IllegalTransition
    | OppositeTerminalConflict

[<RequireQualifiedAccess>]
type internal Decision =
    | Transitioned of State
    | Idempotent
    | Rejected of Rejection

/// 许可生命周期律：Pending → Committed → Releasing → Released，或 Pending → Releasing(BeforeProvider)。
/// 两种释放互斥；同一种释放重复是幂等；已提交后不能再“提供方前释放”。
module internal Lifecycle =

    let private sameRelease expected actual =
        if expected = actual then
            Decision.Idempotent
        else
            Decision.Rejected Rejection.OppositeTerminalConflict

    let commit =
        function
        | State.Pending -> Decision.Transitioned State.Committed
        | State.Committed -> Decision.Idempotent
        | State.Releasing _
        | State.Released _ -> Decision.Rejected Rejection.OppositeTerminalConflict

    let beginRelease (requested: Release) =
        function
        | State.Pending when requested = Release.BeforeProvider ->
            Decision.Transitioned(State.Releasing requested)
        | State.Pending -> Decision.Rejected Rejection.IllegalTransition
        | State.Committed when requested = Release.PhysicalCompletion ->
            Decision.Transitioned(State.Releasing requested)
        | State.Committed -> Decision.Rejected Rejection.OppositeTerminalConflict
        | State.Releasing release
        | State.Released release -> sameRelease release requested

    let completeRelease (requested: Release) =
        function
        | State.Releasing release when release = requested -> Decision.Transitioned(State.Released release)
        | State.Releasing release
        | State.Released release -> sameRelease release requested
        | State.Pending
        | State.Committed -> Decision.Rejected Rejection.IllegalTransition

    let name =
        function
        | State.Pending -> "Pending"
        | State.Committed -> "Committed"
        | State.Releasing _ -> "Releasing"
        | State.Released _ -> "Released"

    let rejectionName =
        function
        | Rejection.UnknownLease -> "UnknownLease"
        | Rejection.WrongFence -> "WrongFence"
        | Rejection.StaleLease -> "StaleLease"
        | Rejection.WrongSession -> "WrongSession"
        | Rejection.WrongPhysicalUserMessage -> "WrongPhysicalUserMessage"
        | Rejection.WrongRole -> "WrongRole"
        | Rejection.WrongParticipant -> "WrongParticipant"
        | Rejection.WrongTarget -> "WrongTarget"
        | Rejection.IllegalTransition -> "IllegalTransition"
        | Rejection.OppositeTerminalConflict -> "OppositeTerminalConflict"

    /// 结果分类：成功、重复、过期（未知/错 fence/被替代）与冲突。
    let outcome =
        function
        | Decision.Transitioned _ -> "Applied"
        | Decision.Idempotent -> "AlreadyApplied"
        | Decision.Rejected Rejection.UnknownLease
        | Decision.Rejected Rejection.WrongFence
        | Decision.Rejected Rejection.StaleLease -> "StaleFence"
        | Decision.Rejected _ -> "Conflict"

    let observed (issued: Identity) (seen: Identity) =
        if seen.SessionId <> issued.SessionId then
            Error Rejection.WrongSession
        elif seen.PhysicalUserMessageId <> issued.PhysicalUserMessageId then
            Error Rejection.WrongPhysicalUserMessage
        elif seen.Role <> issued.Role then
            Error Rejection.WrongRole
        elif seen.Participant <> issued.Participant then
            Error Rejection.WrongParticipant
        elif seen.Model <> issued.Model || seen.Reasoning <> issued.Reasoning then
            Error Rejection.WrongTarget
        else
            Ok()

type internal Entry =
    { Handle: obj
      Identity: Identity
      Credit: float
      Fence: float
      // DSL-MUTABLE: state — the one lifecycle of this exact permit
      mutable State: State }

/// wanxiangli/permit 公开入口：精确执行容量许可的 owner（CUT-10）。
/// 每个会话至多一张当前许可；许可绑定一次物理执行的精确身份与一个容量 credit。
/// 只管许可的签发、提交、两种互斥释放与只读查询；不选模型、不持有容量账本、不排队。
[<AttachMembers>]
type ExecutionPermits() =
    let issued = Wire.weakSet ()
    let bySession = Dictionary<string, Entry>()
    // DSL-MUTABLE: resource — monotonic permit identity and fence
    let mutable nextLeaseId = 0.0
    let mutable nextFence = 0.0

    let fail (message: string) : 'a =
        raise (InvalidOperationException("execution-model-routing: " + message))

    let handleOf (entry: Entry) (leaseId: float) =
        Wire.freeze (
            createObj
                [ "leaseId" ==> leaseId
                  "fence" ==> entry.Fence
                  "credit" ==> entry.Credit
                  "identity" ==> Identity.encode entry.Identity ]
        )

    /// 认得这张许可：本实例签发、仍是该会话的当前许可、fence 一致。
    let known (permit: obj) (fence: obj) : Result<Entry, Rejection> =
        if Wire.isNullish permit then
            Error Rejection.UnknownLease
        elif not (Wire.has issued permit) then
            Error Rejection.WrongFence
        else
            let identity: obj = permit?identity
            let sessionId = unbox<string> (identity?sessionId: obj)

            match bySession.TryGetValue sessionId with
            | false, _ -> Error Rejection.StaleLease
            | true, entry when not (Wire.same entry.Handle permit) -> Error Rejection.StaleLease
            | true, entry when not (Wire.same (box entry.Fence) fence) -> Error Rejection.WrongFence
            | true, entry -> Ok entry

    let apply (entry: Entry) decision =
        match decision with
        | Decision.Transitioned state -> entry.State <- state
        | Decision.Idempotent
        | Decision.Rejected _ -> ()

        decision

    let release (entry: Entry) (kind: Release) =
        match apply entry (Lifecycle.beginRelease kind entry.State) with
        | Decision.Transitioned _ -> apply entry (Lifecycle.completeRelease kind entry.State)
        | decision -> decision

    let result (value: Result<obj, Rejection>) : obj =
        match value with
        | Ok value -> Wire.freeze (createObj [ "ok" ==> true; "value" ==> value ])
        | Error rejection ->
            Wire.freeze (createObj [ "ok" ==> false; "rejection" ==> Lifecycle.rejectionName rejection ])

    /// 为精确身份签发许可。同一会话、同一身份、同一 credit 的重复签发交还原许可（任何状态）；
    /// 否则签发新许可（新 leaseId 与 fence），替代该会话的旧许可，旧许可此后一律过期。
    member _.issue(identity: obj, credit: obj) : obj =
        let identity = Identity.decode "permit issue" identity

        if not (Wire.isPositiveInteger credit) then
            fail "permit issue requires a positive integer capacity credit"

        let credit = unbox<float> credit

        match bySession.TryGetValue identity.SessionId with
        | true, entry when entry.Identity = identity && entry.Credit = credit -> entry.Handle
        | _ ->
            nextLeaseId <- nextLeaseId + 1.0
            nextFence <- nextFence + 1.0

            let entry =
                { Handle = (null: obj)
                  Identity = identity
                  Credit = credit
                  Fence = nextFence
                  State = State.Pending }

            let handle = handleOf entry nextLeaseId
            Wire.add issued handle
            bySession[identity.SessionId] <- { entry with Handle = handle }
            handle

    /// 许可的 target；过期或伪造的许可给出拒绝。
    member _.target(permit: obj, fence: obj) : obj =
        known permit fence
        |> Result.map (fun entry ->
            Wire.freeze (createObj [ "model" ==> entry.Identity.Model; "reasoning" ==> entry.Identity.Reasoning ]))
        |> result

    /// 提供方观察到的精确身份与许可一致时提交；交还 Applied / AlreadyApplied / StaleFence / Conflict。
    member _.commit(permit: obj, fence: obj, observed: obj) : string =
        let observed = Identity.decode "permit commit" observed

        known permit fence
        |> Result.bind (fun entry ->
            Lifecycle.observed entry.Identity observed
            |> Result.map (fun () -> apply entry (Lifecycle.commit entry.State)))
        |> Result.defaultWith Decision.Rejected
        |> Lifecycle.outcome

    /// 提供方开始前释放（未提交的许可）；已提交的许可只能随物理完成释放。
    member _.releaseBeforeProvider(permit: obj, fence: obj, observed: obj) : string =
        let observed = Identity.decode "permit release" observed

        known permit fence
        |> Result.bind (fun entry ->
            Lifecycle.observed entry.Identity observed
            |> Result.map (fun () -> release entry Release.BeforeProvider))
        |> Result.defaultWith Decision.Rejected
        |> Lifecycle.outcome

    /// 精确物理执行完成：只释放该会话当前许可且物理消息一致的那一张。
    member _.releasePhysical(sessionId: obj, physicalUserMessageId: obj) : string =
        if not (Wire.isString sessionId) || not (Wire.isString physicalUserMessageId) then
            fail "permit physical release requires string sessionId and physicalUserMessageId"

        match bySession.TryGetValue(unbox<string> sessionId) with
        | true, entry when entry.Identity.PhysicalUserMessageId = unbox<string> physicalUserMessageId ->
            release entry Release.PhysicalCompletion
        | true, _ -> Decision.Rejected Rejection.StaleLease
        | false, _ -> Decision.Rejected Rejection.UnknownLease
        |> Lifecycle.outcome

    /// 许可当前状态名：Pending / Committed / Releasing / Released。
    member _.lifecycle(permit: obj, fence: obj) : obj =
        known permit fence |> Result.map (fun entry -> box (Lifecycle.name entry.State)) |> result

    /// 只读：该会话当前许可已提交且物理消息一致时交还它，否则 null。
    member _.committed(sessionId: obj, physicalUserMessageId: obj) : obj =
        if not (Wire.isString sessionId) || not (Wire.isString physicalUserMessageId) then
            null
        else
            match bySession.TryGetValue(unbox<string> sessionId) with
            | true, entry when
                entry.State = State.Committed
                && entry.Identity.PhysicalUserMessageId = unbox<string> physicalUserMessageId
                ->
                entry.Handle
            | _ -> null
