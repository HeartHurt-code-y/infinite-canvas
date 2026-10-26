/*
 * Agent 模式的数据源。
 *
 * 即梦这一档有三份服务端数据：
 *   - `POST /mweb/v1/creation_agent/v2/get_agent_config` → 技能目录、参考素材
 *     限制、提示词上限、生成偏好开关；
 *   - `POST /mweb/v1/creation_agent/v2/skill/list` → 官方技能列表；
 *   - `POST /mweb/v1/dreamina_subject/get` → 主体列表。
 *
 * 本项目后端尚未接入这三份接口（`TODO(agent-skills)` / `TODO(agent-subjects)`），
 * 所以这里用**内置占位目录**把前端跑通：交互、搜索、空态、限制校验都是真的，
 * 只是数据来自本地常量而不是服务端。接上后端时只需替换本文件的三个取值函数。
 *
 * 生成偏好是本地状态，不落盘：Agent 模式的偏好只影响下一次提交的参数，
 * 落盘价值低，且服务端偏好表里还没有对应字段（`TODO(agent-preferences)`）。
 */
import { useCallback, useMemo, useState } from "react";
import {
  AGENT_REFERENCE_LIMITS,
  AGENT_SKILL_CATALOG,
  DEFAULT_AGENT_PREFERENCES,
  enabledAgentSkills,
  type AgentPreferences,
  type AgentSkill,
  type AgentSubject,
} from "./createAgentModel";

export interface UseCreateAgentResult {
  readonly skills: readonly AgentSkill[];
  readonly skill: AgentSkill | null;
  readonly onSkillChange: (skill: AgentSkill | null) => void;
  readonly subjects: readonly AgentSubject[];
  readonly preferences: AgentPreferences;
  readonly onPreferencesChange: (preferences: AgentPreferences) => void;
  readonly selectedSubjects: readonly AgentSubject[];
  readonly onSubjectsChange: (subjects: readonly AgentSubject[]) => void;
  /** 参考素材是否超限（按媒体类型分别计数）。 */
  readonly checkReferenceLimits: (counts: {
    readonly image: number;
    readonly video: number;
    readonly audio: number;
    readonly total: number;
  }) => string | null;
}

/**
 * 技能目录（占位）。
 *
 * 真实实现应从服务端技能市场读取；这里返回内置的官方技能目录，
 * 让「技能」下拉的搜索、角标、说明行都有真实内容可展示。
 */
export function loadAgentSkills(): readonly AgentSkill[] {
  return enabledAgentSkills(AGENT_SKILL_CATALOG);
}

/**
 * 主体列表（占位）。
 *
 * 实测账号一个主体都没有，界面走空态。这里同样返回空数组——
 * 与其塞一个假主体骗用户，不如让空态如实呈现。
 */
export function loadAgentSubjects(): readonly AgentSubject[] {
  return [];
}

export function useCreateAgent(): UseCreateAgentResult {
  const [preferences, setPreferences] = useState<AgentPreferences>(DEFAULT_AGENT_PREFERENCES);
  const [selectedSubjects, setSelectedSubjects] = useState<readonly AgentSubject[]>([]);
  const [skill, setSkill] = useState<AgentSkill | null>(null);

  const skills = useMemo(() => loadAgentSkills(), []);
  const subjects = useMemo(() => loadAgentSubjects(), []);

  const onPreferencesChange = useCallback((next: AgentPreferences) => {
    setPreferences(next);
  }, []);

  const onSkillChange = useCallback((next: AgentSkill | null) => {
    setSkill(next);
  }, []);

  const onSubjectsChange = useCallback((next: readonly AgentSubject[]) => {
    setSelectedSubjects(next);
  }, []);

  /**
   * 参考素材上限校验。
   *
   * 限额取自即梦实测的 `reference_resource_config`：总计 50、图片 30、
   * 视频 10、音频 10。超限时要把「超了多少、换成什么」讲清楚——
   * 只说「超限」用户不知道怎么改。
   */
  const checkReferenceLimits = useCallback(
    (counts: {
      readonly image: number;
      readonly video: number;
      readonly audio: number;
      readonly total: number;
    }): string | null => {
      const { image, video, audio, total } = counts;
      if (total > AGENT_REFERENCE_LIMITS.maxResourceCount) {
        return `参考素材最多 ${AGENT_REFERENCE_LIMITS.maxResourceCount} 个，当前 ${total} 个，请先移除一些。`;
      }
      if (image > AGENT_REFERENCE_LIMITS.maxImageCount) {
        return `图片参考最多 ${AGENT_REFERENCE_LIMITS.maxImageCount} 张，当前 ${image} 张。`;
      }
      if (video > AGENT_REFERENCE_LIMITS.maxVideoCount) {
        return `视频参考最多 ${AGENT_REFERENCE_LIMITS.maxVideoCount} 个，当前 ${video} 个。`;
      }
      if (audio > AGENT_REFERENCE_LIMITS.maxAudioCount) {
        return `音频参考最多 ${AGENT_REFERENCE_LIMITS.maxAudioCount} 个，当前 ${audio} 个。`;
      }
      return null;
    },
    [],
  );

  return {
    skills,
    skill,
    onSkillChange,
    subjects,
    preferences,
    onPreferencesChange,
    selectedSubjects,
    onSubjectsChange,
    checkReferenceLimits,
  };
}
