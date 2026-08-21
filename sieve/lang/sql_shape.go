package lang

import (
	"regexp"
	"strings"
)

// sqlCandidate marks the tier-1 row whose regex is only a MAYBE, so the detection
// loop hands the text to sqlStatements instead of answering from the match. It
// mirrors json_candidate, the other rule the table cannot settle on its own.
const sqlCandidate = "sql_candidate"

// sqlOpeningRe is the cheap pre-filter that puts SQL in the tier-1 order: a
// statement keyword at the start of a line. Deliberately loose — everything that
// makes it an answer rather than a guess lives in sqlShape.
//
// The line anchor is doing real work even here. A sentence that merely USES these
// words ("we should select rows from customers") buries them mid-line; a statement
// always begins one.
var sqlOpeningRe = regexp.MustCompile(`(?i)(?m)^[\t ]*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b`)

// sqlShape recognises SQL by the SHAPE of a statement, never by its vocabulary.
// The vocabulary is treacherous: SELECT, UPDATE, DELETE, FROM and WHERE are all
// ordinary English, and "Delete from the archive anything older than a year" is a
// sentence, not a statement. What separates them is that SQL names a TABLE where
// English puts a noun phrase, terminates lines with a semicolon, comments with --,
// compares values, and gives each clause its own line — so those are what is
// weighed. It answers only for text that already opens with a statement keyword.
type sqlShape struct{}

var sqlStatements sqlShape

var (
	// sqlDDLRe is decisive on its own: a keyword PAIR ("CREATE TABLE", "DROP
	// INDEX") that no English sentence puts together.
	sqlDDLRe = regexp.MustCompile(`(?i)(?m)^[\t ]*(?:` +
		`(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+|TEMP(?:ORARY)?\s+|UNIQUE\s+|MATERIALIZED\s+)*(?:TABLE|INDEX|VIEW|SCHEMA|DATABASE|SEQUENCE|TRIGGER|FUNCTION|PROCEDURE)\b` +
		`|TRUNCATE\s+TABLE\b)`)

	// sqlDMLRe is a statement OPENING — not an answer, because each of these reads
	// as an English clause too. Corroboration decides.
	sqlDMLRe = regexp.MustCompile(`(?i)(?m)^[\t ]*(?:SELECT|WITH|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b`)

	// sqlClauseLineRe is a clause given its own line, the way every formatted query
	// is written. WHERE and HAVING are deliberately absent: "Where do we start?"
	// opens a line of prose readily, and the rest do not.
	sqlClauseLineRe = regexp.MustCompile(`(?i)(?m)^[\t ]*(?:` +
		`FROM|(?:INNER|LEFT|RIGHT|FULL|CROSS|OUTER)\s+JOIN|JOIN|GROUP\s+BY|ORDER\s+BY|` +
		`UNION(?:\s+ALL)?|VALUES|SET|LIMIT|OFFSET)\s+\S`)

	// sqlTerminatorRe is a line that ends in a statement terminator.
	sqlTerminatorRe = regexp.MustCompile(`(?m);[\t ]*$`)

	// sqlCommentRe is a SQL line comment. The trailing space keeps a markdown rule
	// ("---") and an em-dash out.
	sqlCommentRe = regexp.MustCompile(`(?m)^[\t ]*--[ \t]`)

	// sqlComparisonRe is a column weighed against a value — the thing a query does
	// and a sentence does not.
	sqlComparisonRe = regexp.MustCompile("(?i)[\\w.\"`\\]]+\\s*(?:=|<>|!=|>=|<=|<|>)\\s*(?:'[^']*'|\\d|[\\w.\"`\\[]+)")

	// sqlTableRefRe captures the operand of the keywords that take a table name.
	sqlTableRefRe = regexp.MustCompile(`(?i)\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_]\w*)`)
)

// englishDeterminers are the words a SENTENCE puts after "from"/"into"/"update"
// and a query never does. They are the whole of the table-reference test: SQL says
// "FROM customers", English says "from the menu".
var englishDeterminers = map[string]bool{
	"the": true, "a": true, "an": true, "this": true, "that": true, "these": true,
	"those": true, "my": true, "your": true, "our": true, "their": true, "its": true,
	"his": true, "her": true, "any": true, "all": true, "each": true, "every": true,
	"some": true, "both": true, "either": true, "neither": true, "another": true,
	"one": true, "two": true, "three": true, "several": true, "many": true,
	"few": true, "most": true, "other": true, "such": true, "which": true,
	"what": true, "whichever": true, "whatever": true, "here": true, "there": true,
	"it": true, "them": true, "us": true, "me": true, "him": true, "you": true,
	"i": true, "we": true, "they": true, "he": true, "she": true, "anything": true,
	"everything": true, "something": true, "nothing": true, "now": true,
}

// matches reports that src is SQL. Callers that have already matched sqlOpeningRe
// (the tier-1 loop) call confirms directly instead.
func (s sqlShape) matches(src string) bool {
	return sqlOpeningRe.MatchString(src) && s.confirms(src)
}

// confirms decides for text that already opens like a statement. DDL settles
// itself; everything else has to corroborate, because its opening is also English.
func (s sqlShape) confirms(src string) bool {
	if sqlDDLRe.MatchString(src) {
		return true
	}
	return sqlDMLRe.MatchString(src) && s.corroborated(src)
}

// corroborated reports at least one signal that a sentence does not produce.
func (s sqlShape) corroborated(src string) bool {
	return sqlClauseLineRe.MatchString(src) ||
		sqlTerminatorRe.MatchString(src) ||
		sqlCommentRe.MatchString(src) ||
		sqlComparisonRe.MatchString(src) ||
		s.namesATable(src)
}

// namesATable reports an operand that reads as a table reference rather than as an
// English noun phrase.
func (s sqlShape) namesATable(src string) bool {
	for _, m := range sqlTableRefRe.FindAllStringSubmatch(src, -1) {
		if !englishDeterminers[strings.ToLower(m[1])] {
			return true
		}
	}
	return false
}
