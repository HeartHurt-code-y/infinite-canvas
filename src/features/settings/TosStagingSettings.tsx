import { Icon } from "../../components/Icon";
import { useEffect, useRef, useState, type FormEvent } from "react";
import * as v from "valibot";
import {
  describeConnectivityTest,
  formatRawBackendError,
  tosStagingClient,
  type TosStagingClient,
  type TosStagingConfig,
} from "../../lib/backend";

interface TosDraft {
  readonly bucket: string;
}

/** AK/SK 在系统凭据管理器中的固定引用名。 */
const TOS_CREDENTIAL_REF = "tos-ak-sk";

const DEFAULT_REGION = "cn-beijing";
const DEFAULT_ENDPOINT = "tos-cn-beijing.volces.com";
const DEFAULT_OBJECT_PREFIX = "staging";

const storedTosCredentialSchema = v.object({
  accessKey: v.string(),
  secretKey: v.string(),
});

function draftFromConfig(config: TosStagingConfig | null): TosDraft {
  return { bucket: config?.bucket ?? "" };
}

/**
 * 隐藏字段（地域/Endpoint/对象前缀）的取值策略：
 * 沿用已保存配置中的值，未配置时使用固定默认值。
 * 这些字段不暴露给用户，后端仍会完整校验。
 */
function hiddenFieldsFromConfig(config: TosStagingConfig | null): {
  readonly region: string;
  readonly endpoint: string;
  readonly objectPrefix: string;
} {
  return {
    // 配置可能被保存为空字符串，空值同样回落到默认值（?? 会保留 ""）。
    region: config?.region ? config.region : DEFAULT_REGION,
    endpoint: config?.endpoint ? config.endpoint : DEFAULT_ENDPOINT,
    objectPrefix: config?.objectPrefix ? config.objectPrefix : DEFAULT_OBJECT_PREFIX,
  };
}

type TosStatusBadge = {
  readonly state: "loading" | "unconfigured" | "enabled";
  readonly text: string;
};

function statusBadge(loading: boolean, savedConfig: TosStagingConfig | null): TosStatusBadge {
  if (loading) return { state: "loading", text: "读取中" };
  // 配置存在且已启用才视为已启用；未配置或桶名/凭据不全（enabled=false）均视为未配置。
  if (!savedConfig || !savedConfig.enabled) {
    return { state: "unconfigured", text: "未配置" };
  }
  return { state: "enabled", text: "已启用" };
}

export function TosStagingSettings({
  client = tosStagingClient,
}: {
  readonly client?: TosStagingClient;
}) {
  const accessKeyRef = useRef<HTMLInputElement | null>(null);
  const secretKeyRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<TosDraft>(() => draftFromConfig(null));
  const [savedConfig, setSavedConfig] = useState<TosStagingConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [testNotice, setTestNotice] = useState<{
    readonly ok: boolean;
    readonly message: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    client
      .getConfig()
      .then(async (config) => {
        if (!active) return;
        setSavedConfig(config);
        setDraft(draftFromConfig(config));
        // 重新打开设置时把已保存的 AK/SK 明文回填到输入框（用户要求「持久化一直显露」）。
        // TOS 凭据以 JSON 形式存储，解析出 accessKey/secretKey 分别填回两个输入框。
        if (!config?.credentialRef) return;
        try {
          const secret = await client.getCredential(config.credentialRef);
          if (!active) return;
          if (!secret) return;
          const parsed = v.safeParse(storedTosCredentialSchema, JSON.parse(secret) as unknown);
          if (!parsed.success) return;
          if (accessKeyRef.current) accessKeyRef.current.value = parsed.output.accessKey;
          if (secretKeyRef.current) secretKeyRef.current.value = parsed.output.secretKey;
        } catch {
          // 凭据读取或解析失败：保持留空，由 credentialSaved 决定「留空则沿用」语义。
        }
      })
      .catch((error: unknown) => {
        if (active) setRawError(formatRawBackendError(error));
      })
      .finally(() => {
        if (active) setLoadingConfig(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  const badge = statusBadge(loadingConfig, savedConfig);
  const credentialSaved = savedConfig?.credentialRef != null;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setRawError(null);
    setSuccessMessage(null);
    setTestNotice(null);

    const bucket = draft.bucket.trim();
    const accessKey = accessKeyRef.current?.value.trim() ?? "";
    // SK 与 AK 同样需要 trim：控制台复制的密钥常带结尾换行/空格，
    // 若不清理，凭据管理器会原样保存“带空白的错误 SK”，本地 HMAC 用其计算签名
    // 必然得到 SignatureDoesNotMatch（AK 因被 trim 能正常回显，更凸显是 SK 出错）。
    const secretKey = secretKeyRef.current?.value.trim() ?? "";

    // AK 与 SK 必须成对提供；两者都留空表示沿用已保存的凭据。
    if (accessKey.length > 0 !== secretKey.length > 0) {
      setRawError("AccessKey 和 SecretKey 需要成对填写；两者都留空则沿用已保存的凭据。");
      return;
    }
    // 填了桶名就必须有凭据（本次填写或已保存），否则保存出的配置无法启用。
    if (bucket && !accessKey && !credentialSaved) {
      setRawError("填写桶名时需要同时填写 AccessKey 和 SecretKey。");
      return;
    }

    // 无开关：桶名与凭据齐备即自动启用，清空桶名即停用。
    const enabled = bucket.length > 0 && (accessKey.length > 0 || credentialSaved);

    setSaving(true);
    try {
      const hidden = hiddenFieldsFromConfig(savedConfig);
      const config: TosStagingConfig = {
        ...hidden,
        bucket,
        credentialRef: enabled ? TOS_CREDENTIAL_REF : null,
        enabled,
      };
      if (accessKey && secretKey) {
        await client.setCredential({
          credentialRef: TOS_CREDENTIAL_REF,
          secret: JSON.stringify({ accessKey, secretKey }),
        });
      }
      await client.configure(config);
      setSavedConfig(config);
      setSuccessMessage(
        enabled
          ? "对象存储直连配置已保存并启用。"
          : "桶名为空，对象存储直连已停用；需要时填写桶名即可启用。",
      );
    } catch (error) {
      setRawError(formatRawBackendError(error));
      return;
    } finally {
      setSaving(false);
    }

    // 保存成功且启用后，自动对真实 TOS 服务做一次连通性测试；结果无论成败都提示用户。
    // 测试失败不影响已保存的配置，只降级为提示。
    if (!enabled) return;
    setTesting(true);
    try {
      const result = await client.testConnectivity();
      setTestNotice({
        ok: result.ok,
        message: describeConnectivityTest(result, "对象存储"),
      });
    } catch (error) {
      setTestNotice({
        ok: false,
        message: `对象存储连通性测试失败：${formatRawBackendError(error)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="tos-settings" aria-labelledby="tos-settings-title">
      <div className="provider-form__heading">
        <span className="settings-step">03</span>
        <div>
          <strong id="tos-settings-title">对象存储直连（TOS）</strong>
          <p>
            只有远程接口必须拿到公网 URL 时（例如本地图片作为视频生成输入），才会短期上传到火山引擎
            TOS 暂存桶；生成结果本身始终只保存到本机。填写桶名和 AK/SK
            即自动启用，清空桶名即停用；凭据只保存到系统凭据管理器。 地域固定为 {DEFAULT_REGION}（
            {DEFAULT_ENDPOINT}），暂存对象写入 {DEFAULT_OBJECT_PREFIX}/ 前缀。
          </p>
        </div>
        <span className="tos-status-badge" data-state={badge.state}>
          {badge.state === "loading" ? (
            <Icon name="circle-notch" aria-hidden="true" size="sm" />
          ) : (
            <Icon name="cloud-arrow-up" aria-hidden="true" size="sm" />
          )}
          {badge.text}
        </span>
      </div>

      <form className="provider-form" onSubmit={(event) => void handleSave(event)}>
        <div className="provider-field-grid">
          <label>
            <span>桶名</span>
            <input
              value={draft.bucket}
              spellCheck={false}
              placeholder="my-staging-bucket"
              disabled={loadingConfig || saving}
              onChange={(event) =>
                setDraft((current) => ({ ...current, bucket: event.target.value }))
              }
              aria-describedby="tos-bucket-hint"
            />
            <small id="tos-bucket-hint">
              火山引擎 TOS 的暂存桶名（{DEFAULT_REGION} / {DEFAULT_ENDPOINT}），建议使用私有桶。
            </small>
          </label>
          <label className="provider-field--key">
            <span>AccessKey ID</span>
            <input
              ref={accessKeyRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={credentialSaved ? "留空则沿用已保存凭据" : "火山引擎 AccessKey ID"}
              disabled={loadingConfig || saving}
              aria-describedby="tos-access-key-hint"
            />
            <small id="tos-access-key-hint">
              与 SecretKey 成对填写；只保存到系统凭据管理器，不写入数据库、画布或任务日志。
            </small>
          </label>
          <label className="provider-field--key">
            <span>Secret Access Key</span>
            <input
              ref={secretKeyRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={credentialSaved ? "留空则沿用已保存凭据" : "火山引擎 Secret Access Key"}
              disabled={loadingConfig || saving}
              aria-describedby="tos-secret-key-hint"
            />
            <small id="tos-secret-key-hint">
              预签名 URL 在本机生成，Secret 不随任何网络请求发送。
            </small>
          </label>
        </div>

        <button
          type="submit"
          className="provider-fetch-action"
          data-state={saving || testing ? "loading" : undefined}
          disabled={loadingConfig || saving || testing}
        >
          {saving || testing ? (
            <Icon name="circle-notch" aria-hidden="true" size="md" />
          ) : (
            <Icon name="check-circle" aria-hidden="true" size="md" />
          )}
          {saving ? "正在保存…" : testing ? "正在测试连通性…" : "保存直连配置"}
        </button>
      </form>

      {rawError ? (
        <div className="settings-error" role="alert">
          <strong>完整原始错误</strong>
          <pre tabIndex={0}>{rawError}</pre>
        </div>
      ) : null}
      {successMessage ? (
        <p className="settings-success" role="status">
          <Icon name="check-circle" aria-hidden="true" size="md" />
          {successMessage}
        </p>
      ) : null}
      {testNotice ? (
        <p className={testNotice.ok ? "settings-success" : "settings-error"} role="status">
          {testNotice.ok ? (
            <Icon name="check-circle" aria-hidden="true" size="md" />
          ) : (
            <Icon name="warning-circle" aria-hidden="true" size="md" />
          )}
          {testNotice.message}
        </p>
      ) : null}
    </section>
  );
}
