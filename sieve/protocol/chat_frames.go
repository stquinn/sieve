package protocol

import "sieve/sieve/block"

// The chat frame rides the document channel of a chat: a channel opened on the uuid of a stored
// chat. A chat is a list of exchanges, each an ai-block, and it only grows; no block op, document
// update or other document verb is served on it. Its exchanges reach the client the way a note's
// blocks do: a new exchange as an insert-block, and every change to one, its status and each block
// of its answer as it is written, as a block-attrs-updated carrying the exchange. A failed or
// interrupted exchange, or a block nested in an answer, is run again by a retry-block-job.

// ChatAppendExchangeFrame asks a question in this channel's chat, as a new exchange after the last.
// It is not answered: the new exchange arrives as an insert-block, born PENDING, and its answer
// follows as block-attrs-updated frames. It is refused with an error frame when the channel is not
// open on a chat or the question holds no block.
type ChatAppendExchangeFrame struct {
	Type     string                `json:"type"`
	Question []block.FrontendBlock `json:"question" doc:"the question, as the ordered blocks the exchange holds verbatim; at least one. A block with no id is given one"`
}
