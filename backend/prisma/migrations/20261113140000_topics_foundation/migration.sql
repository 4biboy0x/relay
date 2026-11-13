CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Topic_slug_key" ON "Topic"("slug");
CREATE INDEX "Topic_name_idx" ON "Topic"("name");

CREATE TABLE "PostTopic" (
    "postId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostTopic_pkey" PRIMARY KEY ("postId", "topicId"),
    CONSTRAINT "PostTopic_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PostTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PostTopic_topicId_createdAt_idx" ON "PostTopic"("topicId", "createdAt" DESC);

CREATE TABLE "UserTopic" (
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserTopic_pkey" PRIMARY KEY ("userId", "topicId"),
    CONSTRAINT "UserTopic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserTopic_topicId_createdAt_idx" ON "UserTopic"("topicId", "createdAt" DESC);

INSERT INTO "Topic" ("id", "slug", "name") VALUES
  ('programming', 'programming', 'Programming'),
  ('cybersecurity', 'cybersecurity', 'Cybersecurity'),
  ('technology', 'technology', 'Technology'),
  ('education', 'education', 'Education'),
  ('science', 'science', 'Science'),
  ('gaming', 'gaming', 'Gaming'),
  ('sports', 'sports', 'Sports'),
  ('business', 'business', 'Business'),
  ('entertainment', 'entertainment', 'Entertainment'),
  ('lifestyle', 'lifestyle', 'Lifestyle');

WITH classified AS (
  SELECT "id",
    CASE
      WHEN "body" ~* '(cybersecurity|ethical[[:space:]]hacking|malware|phishing|pentest|vulnerability|exploit|أمن سيبراني|اختراق|حماية)' THEN 'cybersecurity'
      WHEN "body" ~* '(programming|coding|python|javascript|typescript|software|react|node|برمجة|بايثون)' THEN 'programming'
      WHEN "body" ~* '(technology|artificial intelligence|machine learning|computer|smartphone|تقنية|ذكاء اصطناعي)' THEN 'technology'
      WHEN "body" ~* '(education|learning|school|university|course|teaching|تعليم|دراسة|جامعة)' THEN 'education'
      WHEN "body" ~* '(science|physics|chemistry|biology|space|research|علم|فيزياء|كيمياء)' THEN 'science'
      WHEN "body" ~* '(gaming|playstation|xbox|steam|minecraft|ألعاب|لعبة)' THEN 'gaming'
      WHEN "body" ~* '(football|soccer|basketball|tennis|fitness|رياضة|كرة قدم)' THEN 'sports'
      WHEN "body" ~* '(business|startup|marketing|finance|investment|entrepreneur|تجارة|أعمال|استثمار)' THEN 'business'
      WHEN "body" ~* '(movie|film|music|series|anime|فيلم|موسيقى|أنمي)' THEN 'entertainment'
      WHEN "body" ~* '(lifestyle|health|food|travel|fashion|design|تصميم|سفر|طبخ)' THEN 'lifestyle'
      ELSE NULL
    END AS "topicId"
  FROM "Post"
  WHERE "replyToId" IS NULL AND "deletedAt" IS NULL
)
INSERT INTO "PostTopic" ("postId", "topicId")
SELECT classified."id", classified."topicId"
FROM classified
WHERE classified."topicId" IS NOT NULL;
