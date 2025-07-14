import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { schema } from "../../db/schema/index.ts";
import { db } from "../../db/connection.ts";
import { generareAnswer, generateEmbeddings } from "../../services/gemini.ts";
import { and, eq, sql } from "drizzle-orm";

export const CreateQuestionRoute: FastifyPluginCallbackZod = (app) => {
  app.post(
    "/rooms/:roomId/questions",
    {
      schema: {
        params: z.object({
          roomId: z.string(),
        }),
        body: z.object({
          question: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { roomId } = request.params;
      const { question } = request.body;

      const embeddings = await generateEmbeddings(question);

      const embeddingsLiteral = `'[${embeddings.join(",")}]'::vector`;

      const chunks = await db
        .select({
          id: schema.audioChunks.id,
          transcription: schema.audioChunks.transcription,
          similarity: sql<number>`1 - (${
            schema.audioChunks.embeddings
          } <=> ${sql.raw(embeddingsLiteral)})`,
        })
        .from(schema.audioChunks)
        .where(
          and(
            eq(schema.audioChunks.roomId, roomId),
            sql`1 - (${schema.audioChunks.embeddings} <=> ${sql.raw(
              embeddingsLiteral
            )}) > 0.7`
          )
        )
        .orderBy(
          sql`(${schema.audioChunks.embeddings} <=> ${sql.raw(
            embeddingsLiteral
          )})`
        )
        .limit(3);

      let answer: string | null = null;

      if (chunks.length > 0) {
        const transcriptions = chunks.map((chunk) => chunk.transcription);

        answer = await generareAnswer(question, transcriptions);
      }

      const result = await db
        .insert(schema.questions)
        .values({
          roomId,
          question,
          answer,
        })
        .returning();

      const insertedQuestion = result[0];

      if (!insertedQuestion) {
        throw new Error("Failed to create new question");
      }

      return reply
        .status(201)
        .send({ questionId: insertedQuestion.id, answer });
    }
  );
};
