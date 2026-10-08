import { describe, expect, it } from "vitest";
import { artifactFileName, resultDisplayName, validateArtifactName } from "./artifactNames";

describe("artifact naming", () => {
  it("preserves Chinese names and original extensions without using a label as a path", () => {
    expect(validateArtifactName("第01集_镜头003_选用")).toBeNull();
    expect(artifactFileName("第01集_镜头003", "C:\\Downloads\\无限画布\\task\\old.mp4")).toBe(
      "第01集_镜头003.mp4",
    );
    expect(artifactFileName("角色.PNG", "/outputs/old.png")).toBe("角色.PNG");
    expect(resultDisplayName({ displayName: "人物_选用.png" })).toBe("人物_选用.png");
    expect(resultDisplayName(null)).toBeNull();
    expect(resultDisplayName({ displayName: 1 })).toBeNull();
  });
  it.each(["", "  ", "../镜头", "镜头:003", "CON", "con.txt", "角色.", "角\n色", "字".repeat(61)])(
    "rejects unsafe or unusable name %s",
    (name) => {
      expect(validateArtifactName(name)).not.toBeNull();
    },
  );
});
