// The doc position for an additive BLOCK insert — the single source for every
// create-block and AI-answer insert:
//   - NodeSelection → selection.to, already right after the selected node;
//   - otherwise → after the enclosing TOP-LEVEL block, so a block answer lands as
//     a sibling and never splits the paragraph.
// At a doc-level gap the caret is already a valid top-level point, so use it.
export function blockInsertPos(state) {
  var sel = state.selection
  if (sel.node) return sel.to
  if (sel.$to.depth >= 1) return sel.$to.after(1)
  return sel.to
}
