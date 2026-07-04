- Code Renderis a mess
    - layout is completely wrong coe highliughting doesnt work
    - Code Rneder is dumped into the same file as SieveExtension.  Its not aprt of any dynamic registry
    - safe hightlight is a a part of the Renderer
    - should have purpose built functions/attributes to handle integration with Tip/Tap for editable, selectable, inline or block, can contain children etc etc 

- Paste Pipeline is a shambles.  Its does not mirror the old code.  

- So the paste logic on the old Code pathtook any plain text paste and ran the heuristics.  It scored the text and anything less 3 was code of some form and heuritic and/or AI would try and guess the language.  Anything more than 3 was to be considered plain text and passed on to other handlers.  This pipeline doestn work at all.

- Paste Pipeline SHould post every paste to a function on the Editor.
    - The editor should receive any mime type, cursor location in the document, and nany other front end information required.
    - Teh pipeline should iteratoe processors - giving each one in turn the opportunity to hadnle the paste.  If it does handle it - then it needs to insert the BLOCK into the cursor location  - GO SDIE 
    - send a response that paste handled to the websocket- which should triggera soift reload by the JS.
    - if the past wasnt handled then it should be handed off to TipTap as a notmal prose paste

- Nice ot Have - could we produce a high fidelity Addressing system for the Cursor?  Therefore Paste and insertion could be done server side.  I am ok with the RawYAML being pasted from the SSE/WS as trade off - but would be nice is we could resolve Cursor locations in the Document

- Sieve Block is losing whitepsace, newlines and the like when inserted into an attribute.  I dont know whether that is in the WebSocket Event being transfered or in YAML Serdes - ut multiline code block is losing new lines

- When i insert an empty Code Block - It is appearing in the Document - but I cant edit it - or if I can it turns readonly after a period.

- When I insert an empty code block - and i start to type into the heuristics Score should control when and if any AI job is triggered on it.  So if I dont have a language set. Which an empty block wont on start up - then any update should re-evaluate the Data and as soon as language == null && heuristics < 4 -> set heuristc and ask AI tro refine.  So this impies that the processor interface should have an OnUpdate Hook - which allows it to do some work everytime the front end updates it

- not sure we applied the applicable rules from @how-to-intelligent-fenced-blocks.md 

- Only one that needs specific JS support is IMage paste - as we will have to use existing function to Save the Asset - and then post to GO to embed the Image Fenced Block - adn run all the AI jobs

- Nice ot Have - could we produce a high fidelity Addressing system for the Cursor?  Therefore Paste and insertion could be done server side.  I am ok with the RawYAML being pasted from the SSE/WS as trade off - but would be nice is we could resolve Cursor locations in the Document
