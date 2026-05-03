package requesthandlers

import (
	"github.com/go-chi/chi/v5"
)

type RequestHandler interface {
	RegisterPaths(r chi.Router)
}
