package block

import "sieve/sieve/domain"

// QuestionAttr is the attrs-bag key an ai-block's question elements live under.
const QuestionAttr = domain.QuestionAttr

// AnswerAttr is the attrs-bag key an ai-block's answer elements live under. The
// exchange is symmetric: both slots are element lists in the same encoding, so a
// list of blocks reads the same whichever side of the turn composed it.
const AnswerAttr = "answer"
