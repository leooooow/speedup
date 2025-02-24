import * as path from "path";

import { RunResult } from "sqlite3";

import { IContinueServerClient } from "../continueServer/interface.js";
import { JavaChunk, JavaChunk, IndexTag, IndexingProgressUpdate } from ".java/code.js";
import { DatabaseConnection, SqliteDb, tagToString } from "./refreshIndex.js";
import {
  IndexResultType,
  MarkCompleteCallback,
  PathAndCacheKey,
  RefreshIndexResults,
  type CodebaseIndex,
} from "./types.js";

import { chunkDocument, shouldChunk } from "./chunk/chunk.js";
import { getUriPathBasename } from "../util/uri.js";



export class CodeDefinitionsCodebaseIndex implements CodebaseIndex {
  relativeExpectedTime: number = 1;
  static artifactId = "codeDefinitions";
  artifactId: string = CodeDefinitionsCodebaseIndex.artifactId;

  constructor(
    private readonly readFile: (filepath: string) => Promise<string>,
    private readonly continueServerClient: IContinueServerClient,
    private readonly maxChunkSize: number,
  ) { }

  async *update(
    tag: IndexTag,
    results: RefreshIndexResults,
    markComplete: MarkCompleteCallback,
    repoName: string | undefined,
  ): AsyncGenerator<IndexingProgressUpdate, any, unknown> {
    const db = await SqliteDb.get();
    await this.createTables(db);
    const tagString = tagToString(tag);

    // Check the remote cache
    if (this.continueServerClient.connected) {
      try {
        const keys = results.compute.map(({ cacheKey }) => cacheKey);
        const resp = await this.continueServerClient.getFromIndexCache(
          keys,
          CodeDefinitionsCodebaseIndex.artifactId,
          repoName,
        );

        for (const [cacheKey, codeDefinitions] of Object.entries(resp.files)) {
          await this.insertCodeDefinitions(db, tagString, codeDefinitions);
        }
        results.compute = results.compute.filter(
          (item) => !resp.files[item.cacheKey],
        );
      } catch (e) {
        console.error("Failed to fetch from remote cache: ", e);
      }
    }

    let accumulatedProgress = 0;

    if (results.compute.length > 0) {
      const filepath = results.compute[0].path;
      const folderName = path.basename(path.dirname(filepath));

      yield {
        desc: `Chunking files in ${folderName}`,
        status: "indexing",
        progress: accumulatedProgress,
      };
      const codeDefinitions = await this.computeCodeDefinitions(results.compute);
      await this.insertCodeDefinitions(db, tagString, codeDefinitions);
      await markComplete(results.compute, IndexResultType.Compute);
    }

    // Add tag
    for (const item of results.addTag) {
      await db.run(
        `
          INSERT INTO definitions_tags (definition_id, tag)
          SELECT id, ? FROM code_definitions
          WHERE cacheKey = ? AND path = ?
        `,
        [tagString, item.cacheKey, item.path],
      );
      await markComplete([item], IndexResultType.AddTag);
      accumulatedProgress += 1 / results.addTag.length / 4;
      yield {
        progress: accumulatedProgress,
        desc: `Adding ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
    }

    // Remove tag
    for (const item of results.removeTag) {
      await db.run(
        `
          DELETE FROM definitions_tags
          WHERE tag = ?
            AND definition_id IN (
              SELECT id FROM code_definitions
              WHERE cacheKey = ? AND path = ?
            )
        `,
        [tagString, item.cacheKey, item.path],
      );
      await markComplete([item], IndexResultType.RemoveTag);
      accumulatedProgress += 1 / results.removeTag.length / 4;
      yield {
        progress: accumulatedProgress,
        desc: `Removing ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
    }

    // Delete
    for (const item of results.del) {
      const chunkToDelete = await db.get(
        "SELECT id FROM code_definitions WHERE cacheKey = ?",
        [item.cacheKey],
      );

      if (chunkToDelete) {
        await db.run("DELETE FROM code_definitions WHERE id = ?", [chunkToDelete.id]);

        // Delete from definitions_tags
        await db.run("DELETE FROM definitions_tags WHERE definition_id = ?", [
          chunkToDelete.id,
        ]);
      } else {
        console.debug("Definition to delete wasn't found in the table: ", item.path);
      }

      await markComplete([item], IndexResultType.Delete);
      accumulatedProgress += 1 / results.del.length / 4;
      yield {
        progress: accumulatedProgress,
        desc: `Removing ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
    }
  }

  private async createTables(db: DatabaseConnection) {
    await db.exec(`CREATE TABLE IF NOT EXISTS code_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cacheKey TEXT NOT NULL,
        path TEXT NOT NULL,
        idx INTEGER NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        content TEXT NOT NULL
      )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS definitions_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag TEXT NOT NULL,
          definition_id INTEGER NOT NULL,
          FOREIGN KEY (definition_id) REFERENCES codeDefinitions (id)
      )`);
  }

  private async packToCodeDefinitions(pack: PathAndCacheKey): Promise<Chunk[]> {
    const contents = await this.readFile(pack.path);
    if (!shouldChunk(pack.path, contents)) {
      return [];
    }
    const codeDefinitions: Chunk[] = [];
    const chunkParams = {
      filepath: pack.path,
      contents,
      maxChunkSize: this.maxChunkSize,
      digest: pack.cacheKey,
    };
    for await (const c of chunkDocument(chunkParams)) {
      codeDefinitions.push(c);
    }
    return codeDefinitions;
  }

  private async computeCodeDefinitions(paths: PathAndCacheKey[]): Promise<Chunk[]> {
    const chunkLists = await Promise.all(
      paths.map((p) => this.packToCodeDefinitions(p)),
    );
    return chunkLists.flat();
  }

  private async insertCodeDefinitions(
    db: DatabaseConnection,
    tagString: string,
    codeDefinitions: DefinitionsChunk[],
  ) {
    await new Promise<void>((resolve, reject) => {
      db.db.serialize(() => {
        db.db.exec("BEGIN", (err: Error | null) => {
          if (err) {
            reject(new Error("error creating transaction", { cause: err }));
          }
        });
        const codeDefinitionsSQL =
          "INSERT INTO code_definitions (cacheKey, path, idx, startLine, endLine, content) VALUES (?, ?, ?, ?, ?, ?)";
        codeDefinitions.map((c) => {
          db.db.run(
            codeDefinitionsSQL,
            [c.digest, c.filepath, c.index, c.startLine, c.endLine, c.content],
            (result: RunResult, err: Error) => {
              if (err) {
                reject(
                  new Error("error inserting into code_definitions table", {
                    cause: err,
                  }),
                );
              }
            },
          );
          const chunkTagsSQL =
            "INSERT INTO definitions_tags (definition_id, tag) VALUES (last_insert_rowid(), ?)";
          db.db.run(
            chunkTagsSQL,
            [tagString],
            (result: RunResult, err: Error) => {
              if (err) {
                reject(
                  new Error("error inserting into definitions_tags table", {
                    cause: err,
                  }),
                );
              }
            },
          );
        });
        db.db.exec("COMMIT", (err: Error | null) => {
          if (err) {
            reject(
              new Error("error while committing insert code_definitions transaction", {
                cause: err,
              }),
            );
          } else {
            resolve();
          }
        });
      });
    });
  }
}
