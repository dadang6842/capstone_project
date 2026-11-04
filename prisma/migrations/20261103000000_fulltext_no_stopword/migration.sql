-- 검색(DOC-01)에서 "RAG", "Agent"처럼 영문 검색어가 안 걸리던 문제 수정.
-- ngram 파서는 불용어(a, i, is 등)가 들어간 2글자 토큰("ra", "ag")을 색인에서 빼기 때문에
-- 불용어를 끈 세션에서 인덱스를 다시 만든다. 불용어 설정은 인덱스를 만들 때 정해지고, 이후 새 행에도 그대로 적용된다.
SET SESSION innodb_ft_enable_stopword = OFF;

-- DropIndex
DROP INDEX `ftx_documents_search` ON `documents`;

-- CreateIndex
CREATE FULLTEXT INDEX `ftx_documents_search` ON `documents`(`title`, `content`) WITH PARSER ngram;