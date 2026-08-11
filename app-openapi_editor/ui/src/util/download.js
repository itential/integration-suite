// Triggers a browser download of the given data as a JSON file. Shared by
// SaveConfirmModal, DeleteConfirmModal, IntegrationInstances, and the
// toolbar's standalone Backup button - anywhere a "download this before
// something destructive happens" option is offered.
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Reads a File (e.g. from an <input type="file"> Restore picker) and
// parses it as JSON, rejecting with a clear message on bad input rather
// than letting a cryptic parse error surface.
export function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (err) {
        reject(new Error(`"${file.name}" is not valid JSON: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error(`Couldn't read "${file.name}"`));
    reader.readAsText(file);
  });
}
