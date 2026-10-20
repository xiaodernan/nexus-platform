with open(r'D:\获客平台\apps\ai\tests\test_structured_preferences.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Fix the indentation for the ambience test function
new_lines = []
in_function = False
for line in lines:
    if 'async def test_ambience_preference_matches_boolean_attributes' in line:
        in_function = True
        new_lines.append(line)
        continue
    
    if in_function:
        # Skip the class SqlLikeBackend definition and its methods
        if 'class SqlLikeBackend' in line:
            # Skip until we find the backend = SqlLikeBackend line
            while i < len(lines) and 'backend = SqlLikeBackend' not in lines[i]:
                i += 1
            # Now we're at the backend = SqlLikeBackend line
            continue
    
    new_lines.append(line)

with open(r'D:\获客平台\apps\ai\tests\test_structured_preferences.py', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print('Done')