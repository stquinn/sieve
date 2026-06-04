import glob

for filename in glob.glob("sieve/*_processor_test.go"):
    with open(filename, "r") as f:
        content = f.read()
    
    content = content.replace('fmt.Println("hi")', 'fmt.Println(\\"hi\\")')

    with open(filename, "w") as f:
        f.write(content)

