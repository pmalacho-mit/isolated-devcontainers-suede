from dataclasses import dataclass


@dataclass
class User:
    """A person who can sign in."""

    name: str
    email: str

    def greeting(self) -> str:
        return "Hello, " + self.name


def find(users, email):
    for user in users:
        if user.email == email:
            return user
    return None
