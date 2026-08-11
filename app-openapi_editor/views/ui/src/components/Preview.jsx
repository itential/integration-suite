import React from 'react';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';

// Renders the live-parsed spec using the actual Swagger UI component (the
// same rendering engine editor.swagger.io uses on its right-hand pane), so
// this updates in real time as the JSON on the left is edited. Supports
// OpenAPI 3.0.x and 3.1.0 documents.
export default function Preview({ spec, parseError }) {
  if (parseError) {
    return (
      <div className="preview-pane">
        <div className="preview-error">
          Cannot render preview - the document is not valid JSON:
          <br />
          {parseError}
        </div>
      </div>
    );
  }

  if (!spec) {
    return <div className="preview-pane"><div className="preview-empty">Select a model to preview it</div></div>;
  }

  return (
    <div className="preview-pane swagger-preview-pane">
      <SwaggerUI
        spec={spec}
        docExpansion="list"
        defaultModelsExpandDepth={-1}
        displayRequestDuration
      />
    </div>
  );
}
