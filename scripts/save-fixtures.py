# Joins chunked fixture JSON (an array of string pieces of one JSON object,
# {name: answer, ...}) and writes each answer to tests/fixtures/<name>.json.
import json, sys, os
chunks = json.load(open(sys.argv[1]))
data = json.loads(''.join(chunks))
out = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures')
for name, v in data.items():
    with open(os.path.join(out, f'{name}.json'), 'w') as f:
        json.dump(v, f, indent=1)
        f.write('\n')
    print(name, os.path.getsize(os.path.join(out, f'{name}.json')))
