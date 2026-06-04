import glob

for filename in glob.glob("sieve/*_processor_test.go"):
    with open(filename, "r") as f:
        content = f.read()
    
    content = content.replace('\\"', '"')

    with open(filename, "w") as f:
        f.write(content)

