import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkGitFiles, collectRepoHints, parseGitUrl, scoreRepoMatch } from "./git.ts";
import { retrieve } from "./retrieve.ts";
import { makeChunkId } from "./parsers.ts";
import { SAMPLE_GIT_FILES, SAMPLE_ZOOM_MINUTES } from "./sample-data.ts";
import { extractMinutes } from "./minutes.ts";
import { parseFile } from "./parsers.ts";
import type { Chunk } from "./types.ts";

describe("parseGitUrl", () => {
  it("parses https, ssh, and owner/name", () => {
    const a = parseGitUrl("https://github.com/acme/knowledge-hub.git");
    assert.deepEqual(a, {
      host: "github",
      owner: "acme",
      name: "knowledge-hub",
      url: "https://github.com/acme/knowledge-hub",
    });
    const b = parseGitUrl("git@github.com:acme/knowledge-hub.git");
    assert.equal(b?.owner, "acme");
    assert.equal(b?.name, "knowledge-hub");
    const c = parseGitUrl("acme/knowledge-hub");
    assert.equal(c?.host, "github");
    assert.equal(c?.name, "knowledge-hub");
    const d = parseGitUrl("https://gitlab.com/group/proj");
    assert.equal(d?.host, "gitlab");
    assert.equal(parseGitUrl("not a repo"), null);
  });
});

describe("collectRepoHints", () => {
  it("extracts github URLs and owner/name from minutes", () => {
    const hints = collectRepoHints([
      "After minutes, ground answers in github.com/acme/knowledge-hub",
      "Bob: index the acme/knowledge-hub repo",
    ]);
    assert.ok(hints.some((h) => /acme\/knowledge-hub/i.test(h)));
  });
});

describe("git chunks + retrieve", () => {
  it("chunks sample repo files as git/code", () => {
    const chunks = chunkGitFiles(SAMPLE_GIT_FILES, "acme/knowledge-hub");
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.sourceType === "git"));
    assert.ok(chunks.every((c) => c.chunkKind === "code"));
    assert.ok(chunks.some((c) => c.text.includes("chunk_speaker_turns")));
  });

  it("ranks git alongside zoom minutes for a schema question", () => {
    const turns = parseFile(SAMPLE_ZOOM_MINUTES, "zoom.txt", "zoom");
    const meeting = extractMinutes({
      content: SAMPLE_ZOOM_MINUTES,
      sourceFile: "zoom.txt",
      sourceType: "zoom",
      connectorId: "zoom",
      documentId: "d",
      chunks: turns,
    });
    assert.ok(meeting);
    const git = chunkGitFiles(SAMPLE_GIT_FILES, "acme/knowledge-hub");
    const chunks: Chunk[] = [...turns, ...git].map((p) => ({
      id: makeChunkId(p),
      text: p.text,
      sourceType: p.sourceType,
      timestamp: p.timestamp,
      sourceFile: p.sourceFile,
      documentId: "d",
      connectorId: p.sourceType === "git" ? "git" : "zoom",
      chunkKind: p.chunkKind ?? "turn",
    }));
    const hits = retrieve(
      "Does the knowledge-hub git repo match what we decided about the chunk schema?",
      chunks,
      5,
    );
    const types = new Set(hits.map((h) => h.sourceType));
    assert.ok(types.has("git"), "expected a git hit");
  });

  it("scores an exact repo name match highly", () => {
    const score = scoreRepoMatch(["knowledge-hub", "acme/knowledge-hub"], {
      name: "knowledge-hub",
      fullName: "acme/knowledge-hub",
      description: "local retrieval",
    });
    assert.ok(score >= 0.9);
  });
});
